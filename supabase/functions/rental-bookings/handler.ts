import { readRentalCommand, readRentalQuery, type RentalCommand, type RentalQuery } from '../../../packages/domain/src/rentalBooking.ts';
import type { RateAction, RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';
export const RENTAL_STATUS: Record<string, number> = {
  invalid_input: 400, invalid_time: 400, minimum_duration: 400, duration_increment: 400, maximum_duration: 400, slot_alignment: 400,
  player_required: 403, not_player: 403, not_owner: 403, booking_not_found: 404, court_unavailable: 404, venue_unavailable: 404,
  start_not_future: 409, outside_horizon: 409, outside_hours: 409, allocation_conflict: 409, request_reused: 409,
  stale_quote: 409, arrival_unavailable: 409, invalid_transition: 409, allocation_ended: 409, price_overflow: 409,
};
export class RentalRejected extends Error {
  constructor(readonly reason: string) { super(reason); }
}
type Dependencies = {
  verifyUser: (token: string) => Promise<string | null>;
  limit: (action: Extract<RateAction, 'hold-create' | 'owner-read' | 'owner-edit' | 'cancel'>, principal: RatePrincipal) => Promise<RateDecision>;
  read: (actor: string, query: RentalQuery) => Promise<unknown>;
  command: (actor: string, command: RentalCommand) => Promise<unknown>;
};
export function createRentalHandler(deps: Dependencies) {
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
    let query: RentalQuery | undefined; let command: RentalCommand | undefined;
    try {
      if (request.method === 'GET') query = readRentalQuery(new URL(request.url).searchParams);
      else {
        if (new URL(request.url).search) return respond(400, { error: 'invalid_request' });
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return respond(415, { error: 'unsupported_media_type' });
        const max = 4096; const declared = request.headers.get('content-length');
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
        command = readRentalCommand(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      }
    } catch { return respond(400, { error: 'invalid_request' }); }
    // Bounded parsing selects a release bucket without preventing cancellation in outages.
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
      if (error instanceof RentalRejected && RENTAL_STATUS[error.reason]) return respond(RENTAL_STATUS[error.reason]!, { error: error.reason }, decision.headers);
      return respond(503, { error: 'temporarily_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
    }
  };
}
