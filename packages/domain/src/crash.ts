/**
 * T51d: anonymous crash reports from the mobile app. A report carries the error, where in the app it happened and
 * which build, never who: no account, device ID or IP. Text is bounded and scrubbed on the device and again on the
 * server. See docs/monitoring.md#mobile-crash-reports-t51d.
 */
export const CRASH_KINDS = ['fatal', 'error', 'render'] as const;
export type CrashKind = typeof CRASH_KINDS[number];
/** `APP_VARIANT` of the build (app.config.ts). Development reports are stored and listed but never alert. */
export const CRASH_VARIANTS = ['development', 'preview', 'production'] as const;
export type CrashVariant = typeof CRASH_VARIANTS[number];
export const CRASH_OS = ['ios', 'android'] as const;
export type CrashOs = typeof CRASH_OS[number];

/** Code-point limits per field; the device truncates to these and the server refuses anything longer. */
export const CRASH_LIMITS = { name: 100, message: 500, stack: 6000, component_stack: 3000, route: 200 } as const;
/** A full report stays far below this; the function refuses larger bodies before parsing. */
export const MAX_CRASH_BYTES = 16 * 1024;
/** The device keeps at most this many unsent reports, each for at most this many days. */
export const CRASH_QUEUE_LIMIT = 10;
export const CRASH_QUEUE_DAYS = 7;
/** Server side (migration 20261014090000): reports are kept 30 days and at most 2,000 are stored per day. */
export const CRASH_RETENTION_DAYS = 30;
export const CRASH_DAILY_CAP = 2000;

export type CrashReport = {
  /** Random per report, so a resent report is stored once. */
  id: string;
  kind: CrashKind;
  name: string;
  message: string;
  stack: string | null;
  /** React's component stack; render errors only. */
  component_stack: string | null;
  /** The screen's path with IDs replaced (`/rental/venue/[id]`). */
  route: string | null;
  app_version: string;
  variant: CrashVariant;
  os: CrashOs;
  os_version: string;
  occurred_at: string;
};
/** What the function stores: the parsed report plus the server's grouping key. */
export type CrashRecord = CrashReport & { fingerprint: string };

export class CrashInputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const OS_VERSION = /^[0-9A-Za-z._ -]{1,32}$/;
const ROUTE = /^\/[^\s?#]{0,199}$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

// Order matters: query strings first (they hold tokens), then tokens and keys, then personal data.
const SCRUBS: [RegExp, string][] = [
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#)'"]*)[?#][^\s)'"]*/gi, '$1'],
  [/\bBearer\s+\S+/gi, 'Bearer <token>'],
  [/\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){1,2}/g, '<token>'],
  [/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+/g, '<key>'],
  [/\bExpo(?:nent)?PushToken\[[^\]]*\]/g, '<token>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '<ip>'],
  // Phone numbers and other long numbers (10+ digits, spaces or dashes allowed). Stack positions stay: a 5.5 MB
  // bundle's columns have at most seven digits.
  [/\+?\d(?:[ -]?\d){9,}/g, '<number>'],
];
// Control characters other than tab and newline, and bidirectional overrides.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g;

/** Removes what could identify a person or unlock something, then cuts to `max` code points (ending in …). */
export function scrubCrashText(text: string, max: number): string {
  let value = text.replace(/\r\n?/g, '\n').replace(CONTROLS, '');
  for (const [pattern, replacement] of SCRUBS) value = value.replace(pattern, replacement);
  const points = [...value];
  return points.length <= max ? value : `${points.slice(0, max - 1).join('')}…`;
}

/** The screen's path without query or hash, with IDs and other long values replaced by `[id]`. */
export function normalizeCrashRoute(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? '';
  const segments = path.split('/').filter(Boolean).map((segment) =>
    UUID.test(segment) || /^\d+$/.test(segment) || /^[A-Za-z0-9_-]{20,}$/.test(segment) || [...segment].length > 40 ? '[id]' : segment);
  const route = `/${segments.join('/')}`.replace(/\s/g, '');
  return [...route].length > CRASH_LIMITS.route ? [...route].slice(0, CRASH_LIMITS.route).join('') : route;
}

const fail = (): never => { throw new CrashInputError('Invalid crash report.'); };
const points = (value: string) => [...value].length;
function text(value: unknown, max: number, required: boolean): string {
  if (typeof value !== 'string' || points(value) > max) fail();
  const scrubbed = scrubCrashText(value as string, max);
  if (required && !scrubbed.trim()) fail();
  return scrubbed;
}
const nullableText = (value: unknown, max: number) => value === null ? null : text(value, max, false);

function instant(value: unknown): string {
  const match = typeof value === 'string' ? TIMESTAMP.exec(value) : null;
  const iso = match ? `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}${match[3]}` : '';
  if (!match || Number.isNaN(Date.parse(iso))) fail();
  return new Date(iso).toISOString();
}

const KEYS = ['id', 'kind', 'name', 'message', 'stack', 'component_stack', 'route', 'app_version', 'variant', 'os', 'os_version', 'occurred_at'];

/** Strict report body: exactly these keys, bounded, with every text field scrubbed again. */
export function readCrashReport(raw: unknown): CrashReport {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail();
  const body = raw as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== KEYS.length || !KEYS.every((key) => Object.hasOwn(body, key))) fail();
  if (typeof body.id !== 'string' || !UUID.test(body.id)) fail();
  if (!(CRASH_KINDS as readonly unknown[]).includes(body.kind) || !(CRASH_VARIANTS as readonly unknown[]).includes(body.variant)
    || !(CRASH_OS as readonly unknown[]).includes(body.os)) fail();
  if (typeof body.app_version !== 'string' || !VERSION.test(body.app_version)
    || typeof body.os_version !== 'string' || !OS_VERSION.test(body.os_version)) fail();
  if (body.route !== null && (typeof body.route !== 'string' || !ROUTE.test(body.route))) fail();
  if (body.kind !== 'render' && body.component_stack !== null) fail();
  return {
    id: (body.id as string).toLowerCase(),
    kind: body.kind as CrashKind,
    name: text(body.name, CRASH_LIMITS.name, true),
    message: text(body.message, CRASH_LIMITS.message, false),
    stack: nullableText(body.stack, CRASH_LIMITS.stack),
    component_stack: nullableText(body.component_stack, CRASH_LIMITS.component_stack),
    route: body.route === null ? null : scrubCrashText(body.route as string, CRASH_LIMITS.route),
    app_version: body.app_version as string,
    variant: body.variant as CrashVariant,
    os: body.os as CrashOs,
    os_version: body.os_version as string,
    occurred_at: instant(body.occurred_at),
  };
}

/**
 * The grouping key: kind, name, the message with numbers blanked and the first five stack frames (the first three
 * component frames for render errors). Frame positions stay, because release stacks are minified and a position is
 * all that tells two crash sites apart; a new build therefore starts new groups.
 */
export async function crashFingerprint(report: Pick<CrashReport, 'kind' | 'name' | 'message' | 'stack' | 'component_stack'>): Promise<string> {
  const lines = (value: string | null) => (value ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const frames = lines(report.stack).filter((line) => /^at\s|@/.test(line)).slice(0, 5);
  const components = report.kind === 'render' ? lines(report.component_stack).slice(0, 3) : [];
  const source = [report.kind, report.name, report.message.replace(/\d+/g, '0'), ...frames, ...components].join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One crash group on the console (`crash_admin_read`): counts per build variant and the latest report's details. */
export type CrashGroup = {
  fingerprint: string;
  kind: CrashKind;
  name: string;
  message: string;
  reports: number;
  development: number;
  preview: number;
  production: number;
  first_seen: string;
  last_seen: string;
  app_version: string;
  os: CrashOs;
  os_version: string;
  route: string | null;
  stack: string | null;
  component_stack: string | null;
};
/** `total` counts every report in the window; `groups` holds at most 50, most recent first. */
export type CrashAdminView = { at: string; days: number; total: number; groups: CrashGroup[] };
export const CRASH_VIEW_DAYS = 7;
export const MAX_CRASH_GROUPS = 50;

const viewError = () => new Error('Unexpected crash view.');
const viewObject = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw viewError();
  return raw as Record<string, unknown>;
};
const viewCount = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw viewError();
  return value as number;
};
const viewInstant = (value: unknown) => { try { return instant(value); } catch { throw viewError(); } };
const viewText = (value: unknown, max: number, nullable = false) => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || points(value) > max) throw viewError();
  return value;
};
const viewEnum = <T extends string>(value: unknown, list: readonly T[]) => {
  if (!(list as readonly unknown[]).includes(value)) throw viewError();
  return value as T;
};

/** Strict `crash_admin_read` reply. */
export function readCrashAdminView(raw: unknown): CrashAdminView {
  const view = viewObject(raw);
  if (!Array.isArray(view.groups) || view.groups.length > MAX_CRASH_GROUPS || view.days !== CRASH_VIEW_DAYS) throw viewError();
  return {
    at: viewInstant(view.at),
    days: CRASH_VIEW_DAYS,
    total: viewCount(view.total),
    groups: view.groups.map((value): CrashGroup => {
      const item = viewObject(value);
      if (typeof item.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(item.fingerprint)) throw viewError();
      const group: CrashGroup = {
        fingerprint: item.fingerprint, kind: viewEnum(item.kind, CRASH_KINDS),
        name: viewText(item.name, CRASH_LIMITS.name)!, message: viewText(item.message, CRASH_LIMITS.message)!,
        reports: viewCount(item.reports), development: viewCount(item.development), preview: viewCount(item.preview), production: viewCount(item.production),
        first_seen: viewInstant(item.first_seen), last_seen: viewInstant(item.last_seen),
        app_version: viewText(item.app_version, 32)!, os: viewEnum(item.os, CRASH_OS), os_version: viewText(item.os_version, 32)!,
        route: viewText(item.route, CRASH_LIMITS.route, true), stack: viewText(item.stack, CRASH_LIMITS.stack, true),
        component_stack: viewText(item.component_stack, CRASH_LIMITS.component_stack, true),
      };
      if (group.reports < 1 || group.development + group.preview + group.production !== group.reports) throw viewError();
      return group;
    }),
  };
}
