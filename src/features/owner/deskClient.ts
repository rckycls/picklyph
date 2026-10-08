import { readBookingOperation, readOperationsDate, readRentalCommand, toManilaDateTime, toUtcIso,
  type BookingOperationCommand, type RentalBooking, type RentalBookingResult, type RentalOwnerEntry, type SessionBooking } from '@picklyph/domain';
import type { AttemptStore } from '../rental/attempt';
import { parseBooking as parseRental } from '../rental/client';
import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from './venueClient';
import { parseSessionBooking } from './walkInClient';

/** Owner front desk (T31): request queue, outside rentals, attendance and arrival payments across rentals and open-play groups. */
export const DESK_REJECTIONS = ['invalid_request', 'invalid_input', 'invalid_time', 'minimum_duration', 'duration_increment', 'maximum_duration',
  'slot_alignment', 'player_required', 'not_player', 'not_owner', 'booking_not_found', 'court_unavailable', 'venue_unavailable', 'session_not_found', 'start_not_future',
  'outside_horizon', 'outside_hours', 'allocation_conflict', 'request_reused', 'stale_quote', 'arrival_unavailable', 'invalid_transition',
  'allocation_ended', 'price_overflow', 'not_started', 'payment_recorded', 'amount_mismatch'] as const;
export type DeskReason = typeof DESK_REJECTIONS[number];
export type DeskFailure = HttpFailure<DeskReason>;
export type DeskOutcome<T> = HttpOutcome<T, DeskReason>;
export type DeskKind = 'rental' | 'group';
export type DeskBooking = { kind: 'rental'; booking: RentalBooking } | { kind: 'group'; booking: SessionBooking };
export type DeskPage = { at: string | null; bookings: DeskBooking[]; next_cursor: string | null };
export type DeskTransports = { rental: OwnerHttpTransport; group: OwnerHttpTransport };

const fail = (): never => { throw new Error('Unexpected front-desk response'); };
// PostgreSQL emits microseconds; validate the offset form before normalizing to JS precision.
const instant = (v: unknown): string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
  ? toUtcIso(v.replace(/(\.\d{3})\d+/, '$1')) : fail();
const id = (v: unknown): string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : fail();
const parse = (kind: DeskKind, raw: unknown): DeskBooking => kind === 'rental' ? { kind, booking: parseRental(raw) } : { kind, booking: parseSessionBooking(raw) };
export const deskVenue = (b: DeskBooking) => b.kind === 'rental' ? b.booking.allocation.venue_id : b.booking.snapshot.venue_id;
export const deskStart = (b: DeskBooking) => b.kind === 'rental' ? b.booking.allocation.starts_at : b.booking.snapshot.starts_at;
export const deskEnd = (b: DeskBooking) => b.kind === 'rental' ? b.booking.allocation.ends_at : b.booking.snapshot.ends_at;
export const deskTotal = (b: DeskBooking) => b.booking.snapshot.total_centavos;
/** The short reference players see at the top of their full booking reference. */
export const shortReference = (bookingId: string) => bookingId.slice(0, 8).toUpperCase();
/** Pages arrive in UUID order; the desk shows the loaded set by start time. A first page replaces earlier rows. */
export function mergeDesk(rows: DeskBooking[], page: DeskPage, after: string | null): DeskBooking[] {
  const all = after ? [...rows, ...page.bookings] : page.bookings;
  return [...new Map(all.map((b) => [b.booking.id, b])).values()]
    .sort((a, b) => deskStart(a).localeCompare(deskStart(b)) || a.booking.id.localeCompare(b.booking.id));
}
/** Calendar arithmetic on a Manila date string; Manila has no daylight saving time. */
export function shiftDate(date: string, days: number): string {
  const next = new Date(Date.parse(`${readOperationsDate(date)}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  return readOperationsDate(next);
}

function page(kind: DeskKind, venueId: string, body: Record<string, unknown>, keep: (b: DeskBooking) => boolean): DeskPage {
  if (!Array.isArray(body.bookings) || body.bookings.length > 25) return fail();
  const bookings = body.bookings.map((raw) => parse(kind, raw)); const cursor = body.next_cursor === null ? null : id(body.next_cursor);
  if (bookings.some((b, i) => deskVenue(b) !== venueId || !keep(b) || (i > 0 && b.booking.id <= bookings[i - 1]!.booking.id))
    || (cursor !== null && (bookings.length !== 25 || cursor !== bookings[24]!.booking.id))) return fail();
  return { at: null, bookings, next_cursor: cursor };
}
const get = (t: OwnerHttpTransport, params: Record<string, string>, read: (body: Record<string, unknown>) => DeskPage, signal?: AbortSignal) =>
  ownerRequest(t, `${t.endpoint}?${new URLSearchParams(params)}`, { method: 'GET', signal }, read, DESK_REJECTIONS);
const post = <T>(t: OwnerHttpTransport, command: unknown, read: (body: Record<string, unknown>) => T) =>
  ownerRequest(t, t.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }, read, DESK_REJECTIONS);

/** Live pending requests a current owner can accept or decline; ascending UUID pages of 25. */
export function loadRequests(t: DeskTransports, kind: DeskKind, venueId: string, after: string | null, signal?: AbortSignal): Promise<DeskOutcome<DeskPage>> {
  const venue = venueId.toLowerCase();
  return get(t[kind], { section: 'requests', venue_id: venue, ...(after ? { after_id: after } : {}) },
    (body) => page(kind, venue, body, (b) => b.booking.status === 'pending' && (b.kind === 'rental' || b.booking.source === 'player')), signal);
}
/** Confirmed bookings starting on one Manila date; `at` is the server's read time for start-of-play guidance. */
export function loadDay(t: DeskTransports, kind: DeskKind, venueId: string, date: string, after: string | null, signal?: AbortSignal): Promise<DeskOutcome<DeskPage>> {
  const venue = venueId.toLowerCase(); const day = readOperationsDate(date);
  return get(t[kind], { section: 'day', venue_id: venue, date: day, ...(after ? { after_id: after } : {}) }, (body) => {
    if (id(body.venue_id) !== venue || body.date !== day || typeof body.at !== 'string') return fail();
    const result = page(kind, venue, body, (b) => b.booking.status === 'confirmed' && toManilaDateTime(deskStart(b)).date === day);
    return { ...result, at: instant(body.at) };
  }, signal);
}

type Result = { outcome: 'created' | 'existing' | 'changed' | 'expired'; booking: DeskBooking };
function result(kind: DeskKind, body: Record<string, unknown>): Result {
  if (!['created', 'existing', 'changed', 'expired'].includes(String(body.outcome))) return fail();
  return { outcome: body.outcome as Result['outcome'], booking: parse(kind, body.booking) };
}
export function decide(t: DeskTransports, kind: DeskKind, bookingId: string, decision: 'accept' | 'decline'): Promise<DeskOutcome<Result>> {
  const target = bookingId.toLowerCase();
  return post(t[kind], { kind: decision, booking_id: target }, (body) => {
    const r = result(kind, body); const status = r.booking.booking.status;
    return r.booking.booking.id === target && (r.outcome === 'expired' ? status === 'expired'
      : ['changed', 'existing'].includes(r.outcome) && status === (decision === 'accept' ? 'confirmed' : 'declined')) ? r : fail();
  });
}
/** Retrying the same record returns the current state without another event, so an uncertain reply is resolved by resending it. */
export function operate(t: DeskTransports, kind: DeskKind, command: BookingOperationCommand): Promise<DeskOutcome<Result>> {
  const original = readBookingOperation(command);
  return post(t[kind], original, (body) => {
    const r = result(kind, body); const o = r.booking.booking.operations;
    if (r.booking.booking.id !== original.booking_id || !['changed', 'existing'].includes(r.outcome)) return fail();
    const done = original.kind === 'record_payment' ? o.payment?.method === original.method && o.payment.amount_centavos === original.amount_centavos
      : original.kind === 'check_in' ? ['checked_in', 'completed'].includes(o.attendance)
        : o.attendance === (original.kind === 'no_show' ? 'no_show' : 'completed');
    return done ? r : fail();
  });
}
export function enterOutsideRental(t: DeskTransports, command: RentalOwnerEntry): Promise<DeskOutcome<RentalBookingResult>> {
  const original = readRentalCommand(command);
  if (original.kind !== 'owner_entry') throw new Error('Outside rental required');
  return post(t.rental, original, (body) => {
    const r = result('rental', body); const b = r.booking.booking as RentalBooking;
    return ['created', 'existing'].includes(r.outcome) && b.source === 'owner' && b.guest_name === original.guest_name
      && b.allocation.court_id === original.court_id && b.allocation.starts_at === original.starts_at && b.allocation.ends_at === original.ends_at
      && b.snapshot.total_centavos === original.expected_quote.total_centavos ? { outcome: r.outcome, booking: b } as RentalBookingResult : fail();
  });
}

/** One durable uncertain outside rental per backend/account; T47 must clear `.owner-entry-attempt` on account deletion. */
export function createEntryJournal(store: AttemptStore, namespace: string) {
  const key = `${namespace}.owner-entry-attempt`; let busy = false;
  const read = async (): Promise<RentalOwnerEntry | null> => {
    const raw = await store.get(key); if (raw === null) return null;
    const command = readRentalCommand(JSON.parse(raw));
    return command.kind === 'owner_entry' ? command : fail();
  };
  return { read, async run(input: RentalOwnerEntry, send: (command: RentalOwnerEntry) => Promise<DeskOutcome<RentalBookingResult>>) {
    if (busy) throw new Error('An outside booking is already being recorded.');
    busy = true;
    try {
      const command = readRentalCommand(input) as RentalOwnerEntry; const saved = await read();
      if (saved && JSON.stringify(saved) !== JSON.stringify(command)) throw new Error('Resolve your original outside booking before recording another.');
      // Durability before dispatch: a storage failure must not create an untraceable court booking.
      if (!saved) await store.set(key, JSON.stringify(command));
      const outcome = await send(saved ?? command);
      if (outcome.ok || (outcome.failure.kind === 'rejected' && outcome.failure.reason !== 'request_reused')) await store.remove(key);
      return outcome;
    } finally { busy = false; }
  }, forget: () => store.remove(key) };
}

export function deskFailureMessage(f: DeskFailure): string {
  if (f.kind === 'sign_in') return 'Sign in again, then retry the same action.';
  if (f.kind === 'network') return 'Couldn’t reach pickly. The result is uncertain; retry the same action to check it safely.';
  if (f.kind === 'rate_limited') return `Please wait ${f.retryAfterSeconds} seconds before retrying.`;
  if (f.kind === 'not_configured') return 'Front-desk tools aren’t configured in this build.';
  if (f.kind === 'unavailable') return 'Couldn’t confirm the result. Retry the same action shortly to check it safely.';
  const messages: Partial<Record<DeskReason, string>> = {
    not_owner: 'You no longer manage this venue.', venue_unavailable: 'This venue isn’t taking new bookings right now (it must be published with verified ownership).',
    booking_not_found: 'This booking is no longer available. Reload the list.', session_not_found: 'This session is no longer available. Reload the list.',
    invalid_transition: 'This booking changed and that step no longer applies. Reload to see its current state.',
    not_started: 'Check-in, no-shows and payments open at the booking’s start time.',
    payment_recorded: 'A different payment is already recorded for this booking. Reload to see it.',
    amount_mismatch: 'The amount must equal the booking total. Reload the booking and try again.',
    allocation_conflict: 'That time overlaps another booking, block or session on this court.',
    outside_hours: 'That time isn’t fully inside this court’s hours and rates.', stale_quote: 'Rates or policy changed. Get a fresh price and review it again.',
    arrival_unavailable: 'This venue currently takes online payment only, so pay-at-venue bookings can’t be recorded.',
    start_not_future: 'The start must still be in the future according to the server.', outside_horizon: 'Choose a start within the next 60 days.',
    court_unavailable: 'This court isn’t accepting bookings right now.', allocation_ended: 'This hold has ended. Reload the requests.',
    request_reused: 'This request key belongs to different booking details. Resolve the original outside booking first.',
  };
  return (f.kind === 'rejected' ? messages[f.reason] : null) ?? 'Check the details and try again.';
}
