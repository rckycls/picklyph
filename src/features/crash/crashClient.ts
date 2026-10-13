import { CRASH_LIMITS, CRASH_QUEUE_DAYS, CRASH_QUEUE_LIMIT, normalizeCrashRoute, readCrashReport, scrubCrashText,
  type CrashKind, type CrashOs, type CrashReport, type CrashVariant } from '@picklyph/domain';

/**
 * T51d: anonymous crash reports. A report is saved on the device first (a bounded queue), then sent to the
 * crash-reports function; nothing in it names the account, the device or the network. See docs/monitoring.md.
 */
export const CRASH_QUEUE_KEY = 'pickly.crash-reports.v1';
/** A fatal error is saved before React Native's own handler ends the app, waiting at most this long. */
export const FATAL_SAVE_MS = 1500;
/** The same error (kind, name and message) is recorded at most once in this window, so a loop cannot flood the queue. */
export const REPEAT_WINDOW_MS = 60_000;

export type CrashApp = { version: string; variant: CrashVariant; os: CrashOs; osVersion: string };
export type CrashStore = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
/** Sends one report; resolves to the HTTP status, or null when no answer came back. */
export type CrashSend = (report: CrashReport) => Promise<number | null>;
export type CrashContext = { route: string | null; componentStack?: string | null };

function describe(error: unknown): { name: string; message: string; stack: string | null } {
  try {
    if (typeof error === 'object' && error !== null) {
      const value = error as { name?: unknown; message?: unknown; stack?: unknown };
      return { name: typeof value.name === 'string' && value.name.trim() ? value.name : 'Error',
        message: typeof value.message === 'string' ? value.message : '', stack: typeof value.stack === 'string' ? value.stack : null };
    }
    return { name: 'Error', message: String(error), stack: null };
  } catch { return { name: 'Error', message: '', stack: null }; }
}

/** A scrubbed, bounded report, or null if one cannot be made (it is then not recorded). */
export function buildCrashReport(error: unknown, kind: CrashKind, context: CrashContext, app: CrashApp, id: string, now: number): CrashReport | null {
  const { name, message, stack } = describe(error);
  const componentStack = kind === 'render' && context.componentStack?.trim() ? context.componentStack.trim() : null;
  try {
    return readCrashReport({
      id, kind,
      name: scrubCrashText(name, CRASH_LIMITS.name).trim() || 'Error',
      message: scrubCrashText(message, CRASH_LIMITS.message),
      stack: stack === null ? null : scrubCrashText(stack, CRASH_LIMITS.stack),
      component_stack: componentStack === null ? null : scrubCrashText(componentStack, CRASH_LIMITS.component_stack),
      route: context.route === null ? null : normalizeCrashRoute(context.route),
      app_version: /^[0-9A-Za-z.+-]{1,32}$/.test(app.version) ? app.version : '0.0.0',
      variant: app.variant,
      os: app.os,
      os_version: app.osVersion.replace(/[^0-9A-Za-z._ -]/g, '').slice(0, 32).trim() || 'unknown',
      occurred_at: new Date(now).toISOString(),
    });
  } catch { return null; }
}

/** True the first time an error is seen within REPEAT_WINDOW_MS. */
export function createRepeatFilter(now: () => number) {
  const seen = new Map<string, number>();
  return (report: Pick<CrashReport, 'kind' | 'name' | 'message'>) => {
    const at = now();
    for (const [key, time] of seen) if (at - time >= REPEAT_WINDOW_MS) seen.delete(key);
    const key = `${report.kind}\n${report.name}\n${report.message}`;
    if (seen.has(key)) return false;
    seen.set(key, at);
    return true;
  };
}

// 2xx: delivered. 400/413/415: refused as invalid, so resending would not help. Anything else is tried again later.
const settled = (status: number) => (status >= 200 && status < 300) || status === 400 || status === 413 || status === 415;

/** The device queue: at most CRASH_QUEUE_LIMIT reports (oldest dropped), each kept CRASH_QUEUE_DAYS, sent oldest first. */
export function createCrashQueue(ports: { store: CrashStore; send: CrashSend; now: () => number }) {
  let chain: Promise<unknown> = Promise.resolve();
  // Reads and writes take turns, so a report saved during a send is never lost.
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };
  const read = async (): Promise<CrashReport[]> => {
    let list: unknown;
    try { list = JSON.parse((await ports.store.getItem(CRASH_QUEUE_KEY)) ?? '[]'); } catch { return []; }
    if (!Array.isArray(list)) return [];
    const cutoff = ports.now() - CRASH_QUEUE_DAYS * 86_400_000;
    const kept: CrashReport[] = [];
    for (const item of list) {
      try {
        const report = readCrashReport(item);
        if (Date.parse(report.occurred_at) >= cutoff && !kept.some((other) => other.id === report.id)) kept.push(report);
      } catch { /* An unreadable entry is dropped. */ }
    }
    return kept.slice(-CRASH_QUEUE_LIMIT);
  };
  const write = (list: CrashReport[]) => ports.store.setItem(CRASH_QUEUE_KEY, JSON.stringify(list.slice(-CRASH_QUEUE_LIMIT)));
  let flushing: Promise<void> | null = null;
  return {
    add: (report: CrashReport) => serial(async () => {
      const list = await read();
      if (!list.some((other) => other.id === report.id)) list.push(report);
      await write(list);
    }),
    /** Sends until the queue is empty or a send does not settle; one flush at a time. */
    flush: (): Promise<void> => flushing ??= (async () => {
      try {
        for (;;) {
          const next = await serial(async () => (await read())[0] ?? null);
          if (!next) return;
          let status: number | null;
          try { status = await ports.send(next); } catch { status = null; }
          if (status === null || !settled(status)) return;
          await serial(async () => write((await read()).filter((other) => other.id !== next.id)));
        }
      } catch { /* Storage failed; the next flush tries again. */ } finally { flushing = null; }
    })(),
    pending: () => serial(read),
  };
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
export type ErrorUtilsLike = { getGlobalHandler(): GlobalHandler; setGlobalHandler(handler: GlobalHandler): void };

/**
 * Records every error React Native's global handler sees, then hands it on unchanged. A fatal error is passed on only
 * after its report is saved (or `wait` runs out), because React Native ends the app right after. Returns an uninstaller.
 */
export function installCrashHandler(utils: ErrorUtilsLike, record: (error: unknown, fatal: boolean) => Promise<void>,
  wait = FATAL_SAVE_MS, timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout, clearTimeout }) {
  const previous = utils.getGlobalHandler();
  let recording = false;
  utils.setGlobalHandler((error, isFatal) => {
    // An error thrown while recording another one is passed on and never recorded.
    if (recording) { previous(error, isFatal); return; }
    const fatal = isFatal === true;
    let saved: Promise<void>;
    recording = true;
    try { saved = record(error, fatal).catch(() => {}); } catch { saved = Promise.resolve(); } finally { recording = false; }
    if (!fatal) { previous(error, isFatal); return; }
    let passed = false;
    const pass = () => { if (!passed) { passed = true; previous(error, isFatal); } };
    const timer = timers.setTimeout(pass, wait);
    void saved.then(() => { timers.clearTimeout(timer); pass(); });
  });
  return () => utils.setGlobalHandler(previous);
}
