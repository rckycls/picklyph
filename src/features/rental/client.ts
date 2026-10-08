import {
  isPhpCentavos, priceRental, readRentalCommand, toUtcIso,
  type RentalBooking, type RentalBookingPage, type RentalBookingResult, type RentalPrice,
  type RentalQuote, type RentalRequest, type RentalSnapshot, type VenuePolicy,
} from '@picklyph/domain';

import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from '../owner/venueClient';

export type RentalTransport = OwnerHttpTransport;
const REASONS = ['invalid_request', 'invalid_input', 'invalid_time', 'minimum_duration', 'duration_increment', 'maximum_duration',
  'slot_alignment', 'player_required', 'not_player', 'not_owner', 'booking_not_found', 'court_unavailable', 'venue_unavailable',
  'start_not_future', 'outside_horizon', 'outside_hours', 'allocation_conflict', 'request_reused', 'stale_quote',
  'arrival_unavailable', 'invalid_transition', 'allocation_ended', 'price_overflow'] as const;
export type RentalReason = typeof REASONS[number];
export type RentalFailure = HttpFailure<RentalReason>;
export type RentalOutcome<T> = HttpOutcome<T, RentalReason>;
const fail = (): never => { throw new Error('Unexpected rental response'); };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const id = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : fail();
const revision = (v: unknown): string => typeof v === 'string' && /^(0|[1-9]\d{0,18})$/.test(v) ? v : fail();
// PostgreSQL emits microseconds. Validate the calendar and explicit offset before normalizing to JS precision.
const instant = (v: unknown): string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
  ? toUtcIso(v.replace(/(\.\d{3})\d+/, '$1')) : fail();
function policy(raw: unknown): VenuePolicy & { merchant_active: boolean } {
  const p = obj(raw);
  if (!['instant', 'approval'].includes(String(p.confirmation)) || !['arrival', 'both'].includes(String(p.payment))
    || typeof p.merchant_active !== 'boolean' || (!p.merchant_active && p.payment !== 'arrival')) return fail();
  return { confirmation: p.confirmation as VenuePolicy['confirmation'], payment: p.payment as VenuePolicy['payment'], merchant_active: p.merchant_active };
}
function price(raw: Record<string, unknown>, starts: string, ends: string): RentalPrice {
  if (raw.currency !== 'PHP' || raw.pricing !== 'hourly_prorated_half_up_total_v1' || !isPhpCentavos(raw.total_centavos)
    || !Array.isArray(raw.bands) || raw.bands.length < 1 || raw.bands.length > 48) return fail();
  const intervals = raw.bands.map((value) => {
    const b = obj(value); const starts_at = instant(b.starts_at); const ends_at = instant(b.ends_at);
    if (!isPhpCentavos(b.hourly_centavos) || b.duration_minutes !== (Date.parse(ends_at) - Date.parse(starts_at)) / 60000
      || starts_at < starts || ends_at > ends) return fail();
    return { starts_at, ends_at, hourly_centavos: b.hourly_centavos };
  });
  const checked = priceRental(starts, ends, intervals);
  if (checked.duration_minutes < 60 || checked.duration_minutes !== raw.duration_minutes || checked.total_centavos !== raw.total_centavos) return fail();
  // Validation only; the price displayed is the server's immutable price, never a local estimate.
  return checked;
}
export function parseQuote(raw: unknown): RentalQuote {
  const q = obj(raw); const starts_at = instant(q.starts_at); const ends_at = instant(q.ends_at);
  const v = obj(q.expected_quote); const checked = price(q, starts_at, ends_at);
  if (v.total_centavos !== checked.total_centavos) return fail();
  return { ...checked, court_id: id(q.court_id), venue_id: id(q.venue_id), starts_at, ends_at, quoted_at: instant(q.quoted_at), policy: policy(q.policy),
    expected_quote: { total_centavos: checked.total_centavos, schedule_revision: revision(v.schedule_revision),
      court_hours_revision: v.court_hours_revision === null ? null : revision(v.court_hours_revision), policy_revision: revision(v.policy_revision) } };
}
export function parseBooking(raw: unknown): RentalBooking {
  const b = obj(raw); const a = obj(b.allocation); const s = obj(b.snapshot); const p = obj(s.policy);
  const bookingId = id(b.id); const venueId = id(a.venue_id); const courtId = id(a.court_id);
  const starts_at = instant(a.starts_at); const ends_at = instant(a.ends_at);
  if (id(a.id) !== bookingId || a.kind !== 'rental' || !['active', 'released', 'expired'].includes(String(a.state))
    || !['pending', 'confirmed', 'declined', 'cancelled', 'expired'].includes(String(b.status))
    || b.payment_method !== 'arrival' || b.payment_status !== 'unpaid' || s.version !== 1
    || id(s.allocation_id) !== bookingId || id(s.venue_id) !== venueId || id(s.court_id) !== courtId
    || instant(s.starts_at) !== starts_at || instant(s.ends_at) !== ends_at
    || p.player_refund_cutoff_hours !== 24 || p.approval_hold_minutes !== 120 || p.payment_hold_minutes !== 15) return fail();
  const snapshot: RentalSnapshot = { ...price(s, starts_at, ends_at), version: 1, allocation_id: bookingId, venue_id: venueId, court_id: courtId,
    starts_at, ends_at, created_at: instant(s.created_at), schedule_revision: revision(s.schedule_revision),
    court_hours_revision: s.court_hours_revision === null ? null : revision(s.court_hours_revision), policy_revision: revision(s.policy_revision),
    policy: { ...policy(p), player_refund_cutoff_hours: 24, approval_hold_minutes: 120, payment_hold_minutes: 15 } };
  const expires_at = a.expires_at === null ? null : instant(a.expires_at);
  if ((b.status === 'pending' && (expires_at === null || a.state !== 'active' || snapshot.policy.confirmation !== 'approval'))
    || (b.status === 'confirmed' && (expires_at !== null || a.state !== 'active'))
    || (['declined', 'cancelled'].includes(String(b.status)) && a.state !== 'released')
    || (b.status === 'expired' && a.state !== 'expired')) return fail();
  return { id: bookingId, status: b.status as RentalBooking['status'], payment_method: 'arrival', payment_status: 'unpaid',
    created_at: instant(b.created_at), updated_at: instant(b.updated_at), snapshot,
    allocation: { id: bookingId, venue_id: venueId, court_id: courtId, kind: 'rental', starts_at, ends_at,
      expires_at, state: a.state as RentalBooking['allocation']['state'], ended_at: a.ended_at === null ? null : instant(a.ended_at) } };
}
const get = <T>(t: RentalTransport, params: Record<string, string>, parse: (raw: Record<string, unknown>) => T, signal?: AbortSignal) =>
  ownerRequest(t, `${t.endpoint}?${new URLSearchParams(params)}`, { method: 'GET', signal }, parse, REASONS);
export const loadQuote = (t: RentalTransport, window: Pick<RentalRequest, 'court_id' | 'starts_at' | 'ends_at'>, signal?: AbortSignal) =>
  get(t, { section: 'quote', ...window }, (body) => {
    const q = parseQuote(body.quote);
    return q.court_id === window.court_id && q.starts_at === toUtcIso(window.starts_at) && q.ends_at === toUtcIso(window.ends_at) ? q : fail();
  }, signal);
export const loadBooking = (t: RentalTransport, bookingId: string, signal?: AbortSignal) =>
  get(t, { section: 'booking', booking_id: bookingId }, (body) => { const b = parseBooking(body.booking); return b.id === bookingId ? b : fail(); }, signal);
export const loadHistory = (t: RentalTransport, after: string | null, signal?: AbortSignal): Promise<RentalOutcome<RentalBookingPage>> =>
  get(t, { section: 'history', ...(after ? { after_id: after } : {}) }, (body) => {
    if (!Array.isArray(body.bookings) || body.bookings.length > 25) return fail();
    const bookings = body.bookings.map(parseBooking); const cursor = body.next_cursor === null ? null : id(body.next_cursor);
    if (bookings.some((b, i) => b.id <= (i ? bookings[i - 1]!.id : after ?? '')) || (cursor !== null && (bookings.length !== 25 || cursor !== bookings.at(-1)?.id))) return fail();
    return { bookings, next_cursor: cursor };
  }, signal);
export function requestRental(t: RentalTransport, command: RentalRequest): Promise<RentalOutcome<RentalBookingResult>> {
  return mutate(t, command, (b) => b.allocation.court_id === command.court_id && b.allocation.starts_at === command.starts_at && b.allocation.ends_at === command.ends_at
    && b.snapshot.total_centavos === command.expected_quote.total_centavos && b.snapshot.schedule_revision === command.expected_quote.schedule_revision
    && b.snapshot.court_hours_revision === command.expected_quote.court_hours_revision && b.snapshot.policy_revision === command.expected_quote.policy_revision);
}
export const cancelRental = (t: RentalTransport, bookingId: string) => mutate(t, { kind: 'cancel', booking_id: bookingId }, (b) => b.id === bookingId);
function mutate(t: RentalTransport, command: unknown, matches: (b: RentalBooking) => boolean): Promise<RentalOutcome<RentalBookingResult>> {
  const validated = readRentalCommand(command);
  return ownerRequest(t, t.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(validated) }, (body) => {
    if (!['created', 'existing', 'changed', 'expired'].includes(String(body.outcome))) return fail();
    const booking = parseBooking(body.booking); if (!matches(booking)) return fail();
    return { outcome: body.outcome as RentalBookingResult['outcome'], booking };
  }, REASONS);
}
export function rentalFailureMessage(f: RentalFailure): string {
  if (f.kind === 'sign_in') return 'Sign in again, then retry. Your original reservation request is kept.';
  if (f.kind === 'network') return 'Couldn’t reach pickly. If you were reserving, the result is uncertain. Retry the original request to check.';
  if (f.kind === 'rate_limited') return `Please wait ${f.retryAfterSeconds} seconds before retrying.`;
  if (f.kind === 'not_configured') return 'Rentals aren’t configured in this build.';
  if (f.kind === 'unavailable') return 'Couldn’t confirm the result. Retry shortly; an original reservation request is kept for recovery.';
  const messages: Partial<Record<typeof REASONS[number], string>> = {
    stale_quote: 'The price or policy changed. Get a fresh price and review it before reserving again.',
    allocation_conflict: 'That time overlaps another reservation. Choose another court or time.',
    outside_hours: 'That time isn’t fully covered by court hours and rates. Choose another time.',
    arrival_unavailable: 'This venue currently requires online payment. Arrival rentals aren’t offered.',
    venue_unavailable: 'This venue isn’t accepting rentals right now.', court_unavailable: 'This court isn’t accepting rentals right now.',
    start_not_future: 'The start must still be in the future according to the server.', outside_horizon: 'Choose a start within the next 60 days.',
    invalid_transition: 'This booking changed or can no longer be cancelled. Refresh its current status.',
    allocation_ended: 'This hold has ended. Refresh the booking for its current status.',
    booking_not_found: 'This booking is no longer available.', not_player: 'This booking belongs to another account.', not_owner: 'You no longer manage this venue.',
    request_reused: 'This request conflicts with an earlier request. Check booking history; do not submit a new reservation for the same time.',
  };
  return (f.kind === 'rejected' ? messages[f.reason] : null) ?? 'Check the court and times: at least one hour, 30-minute increments, and at most 24 hours.';
}
