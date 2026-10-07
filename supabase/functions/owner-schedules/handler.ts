import { readScheduleQuery, type ScheduleSave, type ScheduleView } from '../../../packages/domain/src/schedule.ts';
import { readCalendarQuery, readScheduleCommand, type CalendarQuery, type CalendarView, type CourtHoursSave, type CourtHoursView, type ScheduleCommand } from '../../../packages/domain/src/calendar.ts';
import type { AllocationBlock, AllocationResult } from '../../../packages/domain/src/allocation.ts';
import { ALLOCATION_STATUS } from '../_shared/allocations.ts';
import type { RateAction, RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';

export class ScheduleRejected extends Error {
  constructor(readonly reason: string) { super(reason); }
}
type Dependencies = {
  verifyUser: (token: string) => Promise<string | null>;
  limit: (action: Extract<RateAction, 'owner-read' | 'owner-edit'>, principal: RatePrincipal) => Promise<RateDecision>;
  read: (actor: string, venue: string, startDate: string, days: number) => Promise<ScheduleView>;
  save: (actor: string, command: ScheduleSave) => Promise<ScheduleView>;
  calendar: (actor: string, venue: string, startDate: string, days: number) => Promise<CalendarView>;
  block: (actor: string, command: AllocationBlock) => Promise<AllocationResult>;
  release: (actor: string, allocationId: string) => Promise<AllocationResult>;
  saveCourtHours: (actor: string, command: CourtHoursSave) => Promise<CourtHoursView>;
};
const REJECTIONS: Record<string, number> = { ...ALLOCATION_STATUS, version_conflict: 409, hours_conflict: 409 };
/** Native/server endpoint: verified identity, no CORS, bounded body, no-store replies. */
export function createScheduleHandler(deps: Dependencies) {
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
    let decision: RateDecision;
    try { decision = await deps.limit(request.method === 'GET' ? 'owner-read' : 'owner-edit', { kind: 'user', id: actor }); }
    catch { return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '5' }); }
    if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
    let query: ReturnType<typeof readScheduleQuery> | undefined; let calendar: CalendarQuery | undefined; let command: ScheduleCommand | undefined;
    try {
      if (request.method === 'GET') {
        const params = new URL(request.url).searchParams;
        if (params.has('section')) calendar = readCalendarQuery(params); else query = readScheduleQuery(params);
      } else {
        if (new URL(request.url).search) return respond(400, { error: 'invalid_request' }, decision.headers);
        if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return respond(415, { error: 'unsupported_media_type' }, decision.headers);
        const declared = request.headers.get('content-length');
        const max = 256 * 1024;
        if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > max)) return respond(413, { error: 'request_too_large' }, decision.headers);
        const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        if (reader) for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > max) { await reader.cancel().catch(() => {}); return respond(413, { error: 'request_too_large' }, decision.headers); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        command = readScheduleCommand(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      }
    } catch { return respond(400, { error: 'invalid_request' }, decision.headers); }
    try {
      let body: unknown;
      if (query) body = await deps.read(actor, query.venue_id, query.start_date, query.days);
      else if (calendar) body = await deps.calendar(actor, calendar.venue_id, calendar.start_date, calendar.days);
      else if (command?.kind === 'save_schedule') body = await deps.save(actor, command.command);
      else if (command?.kind === 'block') body = await deps.block(actor, command.command);
      else if (command?.kind === 'release_block') body = await deps.release(actor, command.command.allocation_id);
      else if (command?.kind === 'save_court_hours') body = await deps.saveCourtHours(actor, command.command);
      return respond(200, body, decision.headers);
    } catch (error) {
      if (error instanceof ScheduleRejected && REJECTIONS[error.reason]) return respond(REJECTIONS[error.reason]!, { error: error.reason }, decision.headers);
      return respond(503, { error: 'temporarily_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
    }
  };
}
