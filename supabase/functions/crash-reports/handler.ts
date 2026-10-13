import { crashFingerprint, MAX_CRASH_BYTES, readCrashReport, type CrashRecord, type CrashReport } from '../../../packages/domain/src/crash.ts';
import type { RateAction, RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';

export const CRASH_OUTCOMES = ['stored', 'existing', 'capped'] as const;
export type CrashOutcome = typeof CRASH_OUTCOMES[number];
/** The database refused the report as off the contract; resending it would not help. */
export class CrashRejected extends Error {}
type Dependencies = {
  guestSource: (headers: Headers) => string;
  limit: (action: Extract<RateAction, 'crash-report'>, principal: RatePrincipal) => Promise<RateDecision>;
  record: (report: CrashRecord) => Promise<CrashOutcome>;
};

/**
 * POST /functions/v1/crash-reports (T51d): the app's anonymous crash reports. No bearer is read, so a report never names
 * an account. The app drops a report on 2xx, 400, 413 and 415 and keeps it for a later try on anything else.
 */
export function createCrashReportHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (request.url.length > 2048 || new URL(request.url).search) return respond(400, { error: 'invalid_request' });
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return respond(415, { error: 'unsupported_media_type' });
    const declared = request.headers.get('content-length');
    if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_CRASH_BYTES)) return respond(413, { error: 'request_too_large' });
    // Limited before the body is read, so a flood costs no parsing.
    let decision: RateDecision;
    try { decision = await deps.limit('crash-report', { kind: 'guest', id: deps.guestSource(request.headers) }); }
    catch { return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '5' }); }
    if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
    let report: CrashReport;
    try {
      const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_CRASH_BYTES) { await reader.cancel().catch(() => {}); return respond(413, { error: 'request_too_large' }, decision.headers); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      report = readCrashReport(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch { return respond(400, { error: 'invalid_report' }, decision.headers); }
    try {
      await deps.record({ ...report, fingerprint: await crashFingerprint(report) });
      return respond(200, { received: true }, decision.headers);
    } catch (error) {
      if (error instanceof CrashRejected) return respond(400, { error: 'invalid_report' }, decision.headers);
      return respond(503, { error: 'temporarily_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
    }
  };
}
