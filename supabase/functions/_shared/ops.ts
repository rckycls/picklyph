import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { OpsSignalKind, OpsSignalSource } from '../../../packages/domain/src/ops.ts';
import type { RateAction, RateDecision, RatePrincipal } from './rate-limit.ts';

/** Records one batch of signals; ops_signal_record behind the service client in production. */
export type SignalWriter = (source: OpsSignalSource, kind: OpsSignalKind, occurrences: number) => Promise<void>;
export type SignalNote = (kind: OpsSignalKind) => void;
export const SIGNAL_INTERVAL_MS = 60_000;

/** Supabase's Edge runtime keeps the isolate alive for background work handed to waitUntil. */
function inBackground(task: Promise<unknown>) {
  (globalThis as { EdgeRuntime?: { waitUntil?: (task: Promise<unknown>) => void } }).EdgeRuntime?.waitUntil?.(task);
}

/**
 * T51a: counts this isolate's signals and writes at most once per kind per minute, so an outage costs one
 * small write a minute. The first signal after a quiet minute is written at once; later ones ride along
 * with the next write. Writing never throws into, delays or changes the response.
 */
export function createSignalReporter(source: OpsSignalSource, write: SignalWriter,
  options: { now?: () => number; defer?: (task: Promise<unknown>) => void } = {}): SignalNote {
  const waiting = new Map<OpsSignalKind, number>();
  const written = new Map<OpsSignalKind, number>();
  return (kind) => {
    waiting.set(kind, (waiting.get(kind) ?? 0) + 1);
    const now = (options.now ?? Date.now)();
    const last = written.get(kind);
    if (last !== undefined && now - last < SIGNAL_INTERVAL_MS) return;
    const occurrences = Math.min(waiting.get(kind)!, 10_000);
    waiting.set(kind, 0);
    written.set(kind, now);
    let task: Promise<unknown>;
    try { task = write(source, kind, occurrences).catch(() => {}); } catch { return; }
    (options.defer ?? inBackground)(task);
  };
}

/** Notes 503s as `unavailable` and other 5xx (or a throw, which the runtime answers with 500) as `server_error`. */
export function observeHandler(handler: (request: Request) => Promise<Response>, note: SignalNote) {
  return async (request: Request): Promise<Response> => {
    let response: Response;
    try { response = await handler(request); } catch (error) { note('server_error'); throw error; }
    if (response.status === 503) note('unavailable');
    else if (response.status >= 500) note('server_error');
    return response;
  };
}

/** Notes every rate-guard decision made under the outage policy (Redis unavailable or misconfigured). */
export function observeGuard(guard: (action: RateAction, principal: RatePrincipal) => Promise<RateDecision>, note: SignalNote) {
  return async (action: RateAction, principal: RatePrincipal): Promise<RateDecision> => {
    const decision = await guard(action, principal);
    if (decision.state === 'degraded') note('limiter_degraded');
    return decision;
  };
}

/** The service client's service-only ops_signal_record. */
export function supabaseSignalWriter(server: () => SupabaseClient<Database>): SignalWriter {
  return async (source, kind, occurrences) => {
    const { error } = await server().rpc('ops_signal_record', { signal_source: source, signal_kind: kind, occurrences });
    if (error) throw new Error('Signal not recorded');
  };
}
