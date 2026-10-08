import { MAX_REPORT_BYTES, readVenueReport, type VenueReportRequest } from '../../../packages/domain/src/moderation.ts';
import type { RateAction, RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';
export const REPORT_STATUS: Record<string, number> = {
  invalid_input: 400, account_required: 403, venue_unavailable: 404,
  already_reported: 409, request_reused: 409, too_many_reports: 409,
};
export class ReportRejected extends Error {
  constructor(readonly reason: string) { super(reason); }
}
type Dependencies = {
  verifyUser: (token: string) => Promise<string | null>;
  limit: (action: Extract<RateAction, 'report-create'>, principal: RatePrincipal) => Promise<RateDecision>;
  submit: (actor: string, report: VenueReportRequest) => Promise<unknown>;
};
/** POST /functions/v1/venue-reports: signed-in players report a published listing. */
export function createVenueReportHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (request.url.length > 2048 || new URL(request.url).search) return respond(400, { error: 'invalid_request' });
    const token = /^Bearer ([^\s]{1,4096})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return respond(401, { error: 'sign_in_required' });
    let actor: string | null;
    try { actor = await deps.verifyUser(token); } catch { return respond(503, { error: 'auth_unavailable' }, { 'Retry-After': '5' }); }
    if (!actor) return respond(401, { error: 'invalid_auth' });
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return respond(415, { error: 'unsupported_media_type' });
    let report: VenueReportRequest;
    try {
      const declared = request.headers.get('content-length');
      if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_REPORT_BYTES)) return respond(413, { error: 'request_too_large' });
      const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_REPORT_BYTES) { await reader.cancel().catch(() => {}); return respond(413, { error: 'request_too_large' }); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      report = readVenueReport(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch { return respond(400, { error: 'invalid_request' }); }
    // A report creates a reviewer task, so like other creation it needs an enforced allowance.
    let decision: RateDecision;
    try { decision = await deps.limit('report-create', { kind: 'user', id: actor }); }
    catch { return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '5' }); }
    if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
    if (decision.state !== 'enforced') return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '5' });
    try {
      return respond(200, await deps.submit(actor, report), decision.headers);
    } catch (error) {
      if (error instanceof ReportRejected && REPORT_STATUS[error.reason]) return respond(REPORT_STATUS[error.reason]!, { error: error.reason }, decision.headers);
      return respond(503, { error: 'temporarily_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
    }
  };
}
