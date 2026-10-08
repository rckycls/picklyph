import { readSessionCreate, toUtcIso, type OpenPlaySession, type SessionCreate, type SessionPage, type SessionResult, type SessionSnapshot } from '@picklyph/domain';
import { parseAllocation } from './calendarClient';
import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from './venueClient';

export const SESSION_REJECTIONS = ['invalid_request', 'invalid_input', 'not_owner', 'session_not_found', 'court_unavailable',
  'venue_unavailable', 'outside_hours', 'allocation_conflict', 'request_reused', 'session_has_bookings', 'session_started'] as const;
export type SessionFailure = HttpFailure<typeof SESSION_REJECTIONS[number]>;
export type SessionOutcome<T> = HttpOutcome<T, typeof SESSION_REJECTIONS[number]>;
const unexpected = (): never => { throw new Error('Unexpected session response.'); };
const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : unexpected();
const id = (raw: unknown): string => typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw.toLowerCase() : unexpected();
// PostgreSQL emits microseconds; normalize only after checking calendar and explicit offset.
const instant = (raw: unknown): string => typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
  ? toUtcIso(raw.replace(/(\.\d{3})\d+/, '$1')) : unexpected();
const revision = (raw: unknown): string => typeof raw === 'string' && /^(0|[1-9]\d{0,18})$/.test(raw) ? raw : unexpected();
const nullableRevision = (raw: unknown) => raw === null ? null : revision(raw);
const dummy = '00000000-0000-4000-8000-000000000000';
export function parseSession(raw: unknown): OpenPlaySession {
  const s = record(raw); const snap = record(s.snapshot); const p = record(snap.policy);
  const input = readSessionCreate({ venue_id: s.venue_id, request_id: dummy, title: snap.title, court_ids: snap.court_ids,
    starts_at: snap.starts_at, ends_at: snap.ends_at, capacity: snap.capacity, group_limit: snap.group_limit, price_centavos: snap.price_centavos });
  if (snap.currency !== 'PHP' || snap.timezone !== 'Asia/Manila' || snap.approval_hold_minutes !== 120
    || snap.payment_hold_minutes !== 15 || snap.refund_cutoff_hours !== 24
    || !['instant', 'approval'].includes(p.confirmation as string) || !['arrival', 'online', 'both'].includes(p.payment as string)
    || typeof p.merchant_active !== 'boolean' || (!p.merchant_active && p.payment !== 'arrival')
    || !['scheduled', 'cancelled'].includes(s.status as string) || (s.status === 'cancelled') !== (s.cancelled_at !== null)
    || !Number.isInteger(s.reserved_spots) || (s.reserved_spots as number) < 0 || (s.reserved_spots as number) > input.capacity
    || !Array.isArray(s.allocations) || s.allocations.length !== input.court_ids.length
    || !Array.isArray(snap.court_hours_revisions) || snap.court_hours_revisions.length !== input.court_ids.length) return unexpected();
  const allocations = s.allocations.map(parseAllocation).sort((a, b) => a.court_id.localeCompare(b.court_id));
  const revisions = snap.court_hours_revisions.map((raw) => { const r = record(raw); return { court_id: id(r.court_id), revision: nullableRevision(r.revision) }; })
    .sort((a, b) => a.court_id.localeCompare(b.court_id));
  if (new Set(allocations.map(a => a.id)).size !== allocations.length || allocations.some((a, i) => a.kind !== 'session'
    || a.venue_id !== input.venue_id || a.court_id !== input.court_ids[i] || a.starts_at !== input.starts_at || a.ends_at !== input.ends_at
    || a.expires_at !== null || a.state !== (s.status === 'cancelled' ? 'released' : 'active'))
    || revisions.some((r, i) => r.court_id !== input.court_ids[i])) return unexpected();
  const snapshot: SessionSnapshot = { title: input.title, court_ids: input.court_ids, starts_at: input.starts_at, ends_at: input.ends_at,
    capacity: input.capacity, group_limit: input.group_limit, price_centavos: input.price_centavos, currency: 'PHP', timezone: 'Asia/Manila', policy: {
    confirmation: p.confirmation as 'instant' | 'approval', payment: p.payment as 'arrival' | 'online' | 'both', merchant_active: p.merchant_active },
    policy_revision: revision(snap.policy_revision), schedule_revision: nullableRevision(snap.schedule_revision), court_hours_revisions: revisions,
    approval_hold_minutes: 120, payment_hold_minutes: 15, refund_cutoff_hours: 24 };
  return { id: id(s.id), venue_id: input.venue_id, status: s.status as OpenPlaySession['status'], created_at: instant(s.created_at),
    cancelled_at: s.cancelled_at === null ? null : instant(s.cancelled_at), snapshot, reserved_spots: s.reserved_spots as number, allocations };
}
export function parseSessionPage(raw: unknown, venueId: string): SessionPage {
  const p = record(raw);
  if (id(p.venue_id) !== venueId.toLowerCase() || !Array.isArray(p.sessions) || p.sessions.length > 25) return unexpected();
  const sessions = p.sessions.map(parseSession);
  const cursor = p.next_cursor === null ? null : id(p.next_cursor);
  if (sessions.some((s, i) => s.venue_id !== venueId.toLowerCase() || (i > 0 && s.id <= sessions[i - 1]!.id))
    || (cursor && (sessions.length !== 25 || cursor !== sessions[24]!.id))) return unexpected();
  return { venue_id: id(p.venue_id), at: instant(p.at), sessions, next_cursor: cursor };
}
function result(raw: unknown): SessionResult {
  const r = record(raw);
  if (!['created', 'existing', 'cancelled'].includes(r.outcome as string)) return unexpected();
  return { outcome: r.outcome as SessionResult['outcome'], session: parseSession(r.session) };
}
export function listSessions(transport: OwnerHttpTransport, venueId: string, after: string | null = null, signal?: AbortSignal): Promise<SessionOutcome<SessionPage>> {
  const params = new URLSearchParams({ venue_id: venueId }); if (after) params.set('after_id', after);
  return ownerRequest(transport, `${transport.endpoint}?${params}`, { method: 'GET', signal }, body => parseSessionPage(body, venueId), SESSION_REJECTIONS);
}
export function createSession(transport: OwnerHttpTransport, command: SessionCreate): Promise<SessionOutcome<SessionResult>> {
  const original = readSessionCreate(command);
  return ownerRequest(transport, transport.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'create', ...original }) }, body => {
    const parsed = result(body); const s = parsed.session.snapshot;
    if (parsed.outcome === 'cancelled' || parsed.session.venue_id !== original.venue_id || s.title !== original.title
      || s.starts_at !== original.starts_at || s.ends_at !== original.ends_at || s.capacity !== original.capacity
      || s.group_limit !== original.group_limit || s.price_centavos !== original.price_centavos
      || s.court_ids.join(',') !== original.court_ids.join(',')) return unexpected();
    return parsed;
  }, SESSION_REJECTIONS);
}
export function cancelSession(transport: OwnerHttpTransport, sessionId: string): Promise<SessionOutcome<SessionResult>> {
  return ownerRequest(transport, transport.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'cancel', session_id: sessionId }) }, body => {
    const parsed = result(body);
    return parsed.session.id === sessionId.toLowerCase() && parsed.session.status === 'cancelled' && parsed.outcome !== 'created' ? parsed : unexpected();
  }, SESSION_REJECTIONS);
}
export function sessionFailureMessage(f: SessionFailure): string {
  if (f.kind === 'rejected') {
    const messages: Record<typeof SESSION_REJECTIONS[number], string> = {
      not_owner: 'You no longer manage this venue.', venue_unavailable: 'Sessions need a published venue with verified ownership.',
      court_unavailable: 'Choose active courts at this venue.', session_not_found: 'This session is no longer available. Reload the list.',
      outside_hours: 'Every selected court must be open for the full session.', allocation_conflict: 'A selected court already has a booking, block or session at that time.',
      request_reused: 'This request key belongs to different session details. Resolve the original session first.',
      session_has_bookings: 'This session has participants. Cancellation with bookings is not available here yet.', session_started: 'This session has already started.',
      invalid_input: 'Check the title, capacity, group limit, price and future times.', invalid_request: 'Check the session details and try again.',
    }; return messages[f.reason];
  }
  if (f.kind === 'rate_limited') return `Try again in ${f.retryAfterSeconds} seconds.`;
  if (f.kind === 'sign_in') return 'Sign in again, then retry the same session request.';
  if (f.kind === 'not_configured') return 'Open-play sessions aren’t configured in this build.';
  return 'Couldn’t confirm the request. Retry the original details to check its result safely.';
}
