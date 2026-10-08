import { MAX_SESSION_BOOKING_BYTES, readSessionBookingCommand, readSessionBookingQuery, type SessionBookingCommand, type SessionBookingQuery } from '../../../packages/domain/src/sessionBooking.ts';
import type { RateAction, RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';
export const SESSION_BOOKING_STATUS: Record<string, number> = {
  invalid_input: 400, player_required: 403, not_player: 403, not_owner: 403,
  booking_not_found: 404, session_not_found: 404, venue_unavailable: 404,
  request_reused: 409, stale_quote: 409, arrival_unavailable: 409, invalid_transition: 409, session_cancelled: 409,
  session_started: 409, session_full: 409, group_limit_exceeded: 409, already_booked: 409,
};
export class SessionBookingRejected extends Error {
  constructor(readonly reason: string) { super(reason); }
}
type Dependencies = {
  verifyUser: (token: string) => Promise<string | null>;
  limit: (action: Extract<RateAction, 'hold-create' | 'owner-read' | 'owner-edit' | 'cancel'>, principal: RatePrincipal) => Promise<RateDecision>;
  read: (actor: string, query: SessionBookingQuery) => Promise<unknown>;
  command: (actor: string, command: SessionBookingCommand) => Promise<unknown>;
};
export function createSessionBookingHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (!['GET', 'POST'].includes(request.method)) return respond(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    if (request.url.length > 2048) return respond(400, { error: 'invalid_request' });
    const token = /^Bearer ([^\s]{1,4096})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return respond(401, { error: 'sign_in_required' });
    let actor: string | null;
    try { actor = await deps.verifyUser(token); } catch { return respond(503, { error: 'auth_unavailable' }, { 'Retry-After': '5' }); }
    if (!actor) return respond(401, { error: 'invalid_auth' });
    let query: SessionBookingQuery | undefined; let command: SessionBookingCommand | undefined;
    try {
      if (request.method === 'GET') query = readSessionBookingQuery(new URL(request.url).searchParams);
      else {
        if (new URL(request.url).search) return respond(400, { error: 'invalid_request' });
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return respond(415, { error: 'unsupported_media_type' });
        // Larger than other commands so a full group of names fits; still streamed and bounded.
        const max = MAX_SESSION_BOOKING_BYTES; const declared = request.headers.get('content-length');
        if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > max)) return respond(413, { error: 'request_too_large' });
        const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        if (reader) for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > max) { await reader.cancel().catch(() => {}); return respond(413, { error: 'request_too_large' }); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        command = readSessionBookingCommand(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      }
    } catch { return respond(400, { error: 'invalid_request' }); }
    // Bounded parsing selects a release bucket without preventing decline/cancellation in outages.
    const action = query ? 'owner-read' : command?.kind === 'request' ? 'hold-create' : command?.kind === 'accept' ? 'owner-edit' : 'cancel';
    let decision: RateDecision;
    try { decision = await deps.limit(action, { kind: 'user', id: actor }); }
    catch {
      if (action === 'cancel' || action === 'owner-read') decision = { allowed: true, status: 200, state: 'degraded', headers: {} };
      else return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '5' });
    }
    if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
    if ((action === 'hold-create' || action === 'owner-edit') && decision.state !== 'enforced')
      return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '5' });
    try {
      return respond(200, query ? await deps.read(actor, query) : await deps.command(actor, command!), decision.headers);
    } catch (error) {
      if (error instanceof SessionBookingRejected && SESSION_BOOKING_STATUS[error.reason])
        return respond(SESSION_BOOKING_STATUS[error.reason]!, { error: error.reason }, decision.headers);
      return respond(503, { error: 'temporarily_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
    }
  };
}
