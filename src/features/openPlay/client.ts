import {
  isPhpCentavos, readSessionBookingCommand, toUtcIso, MAX_SESSION_CAPACITY,
  type SessionBookingPage, type SessionBookingRequest, type SessionBookingResult, type SessionOffer, type SessionOfferPage, type VenuePolicy,
} from '@picklyph/domain';

import { parseSessionBooking } from '../owner/walkInClient';
import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from '../owner/venueClient';

export type GroupTransport = OwnerHttpTransport;
const REASONS = ['invalid_request', 'invalid_input', 'player_required', 'not_player', 'not_owner', 'booking_not_found', 'session_not_found',
  'venue_unavailable', 'session_full', 'group_limit_exceeded', 'already_booked', 'stale_quote', 'session_cancelled', 'session_started',
  'session_ended', 'arrival_unavailable', 'request_reused', 'invalid_transition'] as const;
export type GroupReason = typeof REASONS[number];
export type GroupFailure = HttpFailure<GroupReason>;
export type GroupOutcome<T> = HttpOutcome<T, GroupReason>;
const fail = (): never => { throw new Error('Unexpected open-play response'); };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const id = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : fail();
// PostgreSQL emits microseconds. Validate the calendar and explicit offset before normalizing to JS precision.
const instant = (v: unknown): string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
  ? toUtcIso(v.replace(/(\.\d{3})\d+/, '$1')) : fail();
const count = (v: unknown, min: number, max: number): number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail();
function policy(raw: unknown): VenuePolicy & { merchant_active: boolean } {
  const p = obj(raw);
  if (!['instant', 'approval'].includes(String(p.confirmation)) || !['arrival', 'online', 'both'].includes(String(p.payment))
    || typeof p.merchant_active !== 'boolean' || (!p.merchant_active && p.payment !== 'arrival')) return fail();
  return { confirmation: p.confirmation as VenuePolicy['confirmation'], payment: p.payment as VenuePolicy['payment'], merchant_active: p.merchant_active };
}

/** One session as players see it: the immutable T27 snapshot without revisions, plus spots left at the server's read time. */
export function parseOffer(raw: unknown): SessionOffer {
  const o = obj(raw); const s = obj(o.snapshot);
  if (!Array.isArray(s.court_ids) || s.court_ids.length < 1 || s.court_ids.length > 40) return fail();
  const court_ids = s.court_ids.map(id); const starts_at = instant(s.starts_at); const ends_at = instant(s.ends_at);
  const capacity = count(s.capacity, 1, MAX_SESSION_CAPACITY); const group_limit = count(s.group_limit, 1, capacity);
  const available_spots = count(o.available_spots, 0, capacity);
  if (!['scheduled', 'cancelled'].includes(String(o.status)) || (o.status === 'cancelled' && available_spots !== 0)
    || new Set(court_ids).size !== court_ids.length || typeof s.title !== 'string' || !s.title.trim() || [...s.title].length > 80
    || ends_at <= starts_at || !isPhpCentavos(s.price_centavos) || s.currency !== 'PHP' || s.timezone !== 'Asia/Manila'
    || s.approval_hold_minutes !== 120 || s.payment_hold_minutes !== 15 || s.refund_cutoff_hours !== 24) return fail();
  return { id: id(o.id), venue_id: id(o.venue_id), status: o.status as SessionOffer['status'], available_spots,
    snapshot: { court_ids, title: s.title, starts_at, ends_at, capacity, group_limit, price_centavos: s.price_centavos as number,
      currency: 'PHP', timezone: 'Asia/Manila', policy: policy(s.policy), approval_hold_minutes: 120, payment_hold_minutes: 15, refund_cutoff_hours: 24 } };
}
/** Player history and detail: the shared strict group parser, plus player-only records in history. */
export const parseGroupBooking = parseSessionBooking;

const get = <T>(t: GroupTransport, params: Record<string, string>, parse: (raw: Record<string, unknown>) => T, signal?: AbortSignal) =>
  ownerRequest(t, `${t.endpoint}?${new URLSearchParams(params)}`, { method: 'GET', signal }, parse, REASONS);
export const loadOffers = (t: GroupTransport, venueId: string, after: string | null, signal?: AbortSignal): Promise<GroupOutcome<SessionOfferPage>> =>
  get(t, { section: 'sessions', venue_id: venueId, ...(after ? { after_id: after } : {}) }, (body) => {
    if (id(body.venue_id) !== venueId.toLowerCase() || !Array.isArray(body.sessions) || body.sessions.length > 25) return fail();
    const sessions = body.sessions.map(parseOffer); const cursor = body.next_cursor === null ? null : id(body.next_cursor);
    const key = (s: SessionOffer) => `${s.snapshot.starts_at}|${s.id}`;
    if (sessions.some((s, i) => s.venue_id !== venueId.toLowerCase() || s.status !== 'scheduled' || (i > 0 && key(s) <= key(sessions[i - 1]!))
      || (after !== null && s.id === after.toLowerCase())) || (cursor !== null && (sessions.length !== 25 || cursor !== sessions[24]!.id))) return fail();
    return { venue_id: venueId.toLowerCase(), at: instant(body.at), sessions, next_cursor: cursor };
  }, signal);
export const loadOffer = (t: GroupTransport, sessionId: string, signal?: AbortSignal): Promise<GroupOutcome<{ at: string; session: SessionOffer }>> =>
  get(t, { section: 'session', session_id: sessionId }, (body) => {
    const session = parseOffer(body.session);
    return session.id === sessionId.toLowerCase() ? { at: instant(body.at), session } : fail();
  }, signal);
export const loadGroupBooking = (t: GroupTransport, bookingId: string, signal?: AbortSignal) =>
  get(t, { section: 'booking', booking_id: bookingId }, (body) => {
    const b = parseGroupBooking(body.booking); return b.id === bookingId.toLowerCase() ? b : fail();
  }, signal);
export const loadGroupHistory = (t: GroupTransport, after: string | null, signal?: AbortSignal): Promise<GroupOutcome<SessionBookingPage>> =>
  get(t, { section: 'history', ...(after ? { after_id: after } : {}) }, (body) => {
    if (!Array.isArray(body.bookings) || body.bookings.length > 25) return fail();
    const bookings = body.bookings.map(parseGroupBooking); const cursor = body.next_cursor === null ? null : id(body.next_cursor);
    if (bookings.some((b, i) => b.source !== 'player' || b.id <= (i ? bookings[i - 1]!.id : after?.toLowerCase() ?? ''))
      || (cursor !== null && (bookings.length !== 25 || cursor !== bookings[24]!.id))) return fail();
    return { bookings, next_cursor: cursor };
  }, signal);

const post = (t: GroupTransport, command: unknown, matches: (r: SessionBookingResult) => boolean): Promise<GroupOutcome<SessionBookingResult>> =>
  ownerRequest(t, t.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }, (body) => {
    if (!['created', 'existing', 'changed', 'expired'].includes(String(body.outcome))) return fail();
    const result = { outcome: body.outcome as SessionBookingResult['outcome'], booking: parseGroupBooking(body.booking) };
    return matches(result) ? result : fail();
  }, REASONS);
/** A success must echo the exact session, ordered names and reviewed total; anything else is treated as uncertain. */
export function requestGroup(t: GroupTransport, command: SessionBookingRequest): Promise<GroupOutcome<SessionBookingResult>> {
  const original = readSessionBookingCommand(command);
  if (original.kind !== 'request') throw new Error('Group request required');
  return post(t, original, ({ outcome, booking: b }) => ['created', 'existing'].includes(outcome) && b.source === 'player'
    && b.session_id === original.session_id && b.participants.join('\n') === original.participants.join('\n')
    && b.snapshot.total_centavos === original.expected_total_centavos && (outcome === 'existing' || ['pending', 'confirmed'].includes(b.status)));
}
export const cancelGroup = (t: GroupTransport, bookingId: string) => {
  const original = readSessionBookingCommand({ kind: 'cancel', booking_id: bookingId });
  return post(t, original, ({ outcome, booking: b }) => ['changed', 'existing', 'expired'].includes(outcome) && b.source === 'player'
    && b.id === bookingId.toLowerCase() && ['cancelled', 'expired'].includes(b.status));
};

export function groupFailureMessage(f: GroupFailure): string {
  if (f.kind === 'sign_in') return 'Sign in again, then retry. Your original group request is kept.';
  if (f.kind === 'network') return 'Couldn’t reach pickly. If you were reserving, the result is uncertain. Retry the original request to check.';
  if (f.kind === 'rate_limited') return `Please wait ${f.retryAfterSeconds} seconds before retrying.`;
  if (f.kind === 'not_configured') return 'Open play isn’t configured in this build.';
  if (f.kind === 'unavailable') return 'Couldn’t confirm the result. Retry shortly; an original group request is kept for recovery.';
  const messages: Partial<Record<GroupReason, string>> = {
    session_full: 'Not enough spots left for this group. Remove names or choose another session.',
    group_limit_exceeded: 'Too many people for one group in this session. Remove names to fit the group limit.',
    already_booked: 'You already have a group in this session. Open it from Bookings; to change names, cancel it and reserve again.',
    stale_quote: 'The total didn’t match this session’s price. Reload the session and review the total again.',
    session_cancelled: 'The venue cancelled this session.', session_started: 'This session has already started. Groups can join only before the start.',
    session_ended: 'This session has ended.', arrival_unavailable: 'This session takes online payment only. Pay-at-venue groups aren’t offered.',
    venue_unavailable: 'This venue isn’t accepting open-play groups right now.', session_not_found: 'This session is no longer available.',
    booking_not_found: 'This booking is no longer available.', not_player: 'This booking belongs to another account.',
    not_owner: 'This booking belongs to another account.', player_required: 'Sign in with your own account to join open play.',
    invalid_transition: 'This group changed or can no longer be cancelled. Refresh its current status.',
    request_reused: 'This request conflicts with an earlier request. Check your bookings; don’t submit a new group for the same session.',
  };
  return (f.kind === 'rejected' ? messages[f.reason] : null) ?? 'Check the names: 1–60 characters each, no repeats, up to the group limit.';
}
