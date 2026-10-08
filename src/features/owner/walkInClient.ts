import { readSessionBookingCommand, sessionGroupTotal, toUtcIso,
  type SessionBooking, type SessionBookingPage, type SessionBookingResult, type SessionWalkIn } from '@picklyph/domain';
import type { AttemptStore } from '../rental/attempt';
import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from './venueClient';

export const WALK_IN_REJECTIONS = ['invalid_request', 'invalid_input', 'not_owner', 'booking_not_found', 'session_not_found',
  'venue_unavailable', 'session_full', 'group_limit_exceeded', 'stale_quote', 'session_cancelled', 'session_ended',
  'request_reused', 'invalid_transition'] as const;
export type WalkInFailure = HttpFailure<typeof WALK_IN_REJECTIONS[number]>;
export type WalkInOutcome<T> = HttpOutcome<T, typeof WALK_IN_REJECTIONS[number]>;
const unexpected = (): never => { throw new Error('Unexpected walk-in response.'); };
const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : unexpected();
const id = (raw: unknown): string => typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw.toLowerCase() : unexpected();
// PostgreSQL emits microseconds; normalize only after checking calendar and explicit offset.
const instant = (raw: unknown): string => typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
  ? toUtcIso(raw.replace(/(\.\d{3})\d+/, '$1')) : unexpected();

/** Owner-visible group record. Names are re-validated with the shared request rules; totals must equal price × names. */
export function parseSessionBooking(raw: unknown): SessionBooking {
  const b = record(raw); const snap = record(b.snapshot); const policy = record(snap.policy);
  const body = readSessionBookingCommand({ kind: 'request', session_id: b.session_id, request_id: b.id, participants: b.participants,
    expected_total_centavos: snap.total_centavos });
  if (body.kind !== 'request' || !['player', 'walk_in'].includes(b.source as string)
    || !['pending', 'confirmed', 'declined', 'cancelled', 'expired'].includes(b.status as string)
    || b.payment_method !== 'arrival' || b.payment_status !== 'unpaid' || b.spots !== body.participants.length || snap.spots !== b.spots
    || typeof snap.price_centavos !== 'number' || sessionGroupTotal(snap.price_centavos, body.participants.length) !== body.expected_total_centavos
    || (b.source === 'walk_in' && (b.status === 'pending' || b.expires_at !== null))
    || (b.status === 'pending' && b.expires_at === null) || (b.status === 'confirmed' && b.expires_at !== null) || typeof snap.title !== 'string' || !Array.isArray(snap.court_ids)
    || snap.currency !== 'PHP' || snap.timezone !== 'Asia/Manila' || !['instant', 'approval'].includes(policy.confirmation as string)
    || !['arrival', 'online', 'both'].includes(policy.payment as string) || typeof policy.merchant_active !== 'boolean'
    || typeof snap.policy_revision !== 'string' || snap.approval_hold_minutes !== 120 || snap.payment_hold_minutes !== 15 || snap.refund_cutoff_hours !== 24)
    return unexpected();
  return { id: id(b.id), session_id: body.session_id, source: b.source as SessionBooking['source'], status: b.status as SessionBooking['status'],
    payment_method: 'arrival', payment_status: 'unpaid', participants: body.participants, spots: body.participants.length,
    expires_at: b.expires_at === null ? null : instant(b.expires_at), created_at: instant(b.created_at), updated_at: instant(b.updated_at),
    snapshot: { venue_id: id(snap.venue_id), title: snap.title, court_ids: snap.court_ids.map(id), starts_at: instant(snap.starts_at), ends_at: instant(snap.ends_at),
      price_centavos: snap.price_centavos, spots: body.participants.length, total_centavos: body.expected_total_centavos, currency: 'PHP', timezone: 'Asia/Manila',
      policy: { confirmation: policy.confirmation as 'instant' | 'approval', payment: policy.payment as 'arrival' | 'online' | 'both', merchant_active: policy.merchant_active },
      policy_revision: snap.policy_revision, approval_hold_minutes: 120, payment_hold_minutes: 15, refund_cutoff_hours: 24 } };
}
function result(raw: unknown): SessionBookingResult {
  const r = record(raw);
  if (!['created', 'existing', 'changed', 'expired'].includes(r.outcome as string)) return unexpected();
  return { outcome: r.outcome as SessionBookingResult['outcome'], booking: parseSessionBooking(r.booking) };
}

/** One name per line; blank lines are ignored. The server repeats every check under the session lock. */
export function walkInNames(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
export function walkInDraft(input: { sessionId: string; requestId: string; names: string; priceCentavos: number }): SessionWalkIn {
  const names = walkInNames(input.names);
  const command = readSessionBookingCommand({ kind: 'walk_in', session_id: input.sessionId, request_id: input.requestId, participants: names,
    expected_total_centavos: sessionGroupTotal(input.priceCentavos, names.length) });
  return command as SessionWalkIn;
}

export function listWalkIns(transport: OwnerHttpTransport, sessionId: string, after: string | null = null, signal?: AbortSignal): Promise<WalkInOutcome<SessionBookingPage>> {
  const params = new URLSearchParams({ section: 'walk_ins', session_id: sessionId }); if (after) params.set('after_id', after);
  return ownerRequest(transport, `${transport.endpoint}?${params}`, { method: 'GET', signal }, body => {
    if (!Array.isArray(body.bookings) || body.bookings.length > 25) return unexpected();
    const bookings = body.bookings.map(parseSessionBooking); const cursor = body.next_cursor === null ? null : id(body.next_cursor);
    if (bookings.some((b, i) => b.source !== 'walk_in' || b.session_id !== sessionId.toLowerCase() || (i > 0 && b.id <= bookings[i - 1]!.id))
      || (cursor && (bookings.length !== 25 || cursor !== bookings[24]!.id))) return unexpected();
    return { bookings, next_cursor: cursor };
  }, WALK_IN_REJECTIONS);
}
export function addWalkIn(transport: OwnerHttpTransport, command: SessionWalkIn): Promise<WalkInOutcome<SessionBookingResult>> {
  const original = readSessionBookingCommand(command);
  if (original.kind !== 'walk_in') throw new Error('Walk-in required');
  return ownerRequest(transport, transport.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(original) }, body => {
    const parsed = result(body); const b = parsed.booking;
    if (!['created', 'existing'].includes(parsed.outcome) || b.source !== 'walk_in' || b.session_id !== original.session_id
      || b.participants.join('\n') !== original.participants.join('\n') || b.snapshot.total_centavos !== original.expected_total_centavos) return unexpected();
    return parsed;
  }, WALK_IN_REJECTIONS);
}
export function removeWalkIn(transport: OwnerHttpTransport, bookingId: string): Promise<WalkInOutcome<SessionBookingResult>> {
  return ownerRequest(transport, transport.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'cancel', booking_id: bookingId }) }, body => {
    const parsed = result(body);
    return parsed.booking.id === bookingId.toLowerCase() && parsed.booking.source === 'walk_in' && parsed.booking.status === 'cancelled'
      && ['changed', 'existing'].includes(parsed.outcome) ? parsed : unexpected();
  }, WALK_IN_REJECTIONS);
}

/** One durable uncertain walk-in per backend/account. Never replace its key/names after dispatch. */
export function createWalkInJournal(store: AttemptStore, namespace: string) {
  const key = `${namespace}.walk-in-attempt`; let busy = false;
  const read = async (): Promise<SessionWalkIn | null> => {
    const raw = await store.get(key); if (raw === null) return null;
    const command = readSessionBookingCommand(JSON.parse(raw));
    return command.kind === 'walk_in' ? command : unexpected();
  };
  return { read, async run(input: SessionWalkIn, send: (command: SessionWalkIn) => Promise<WalkInOutcome<SessionBookingResult>>) {
    if (busy) throw new Error('A walk-in is already being added.');
    busy = true;
    try {
      const command = readSessionBookingCommand(input) as SessionWalkIn; const saved = await read();
      if (saved && JSON.stringify(saved) !== JSON.stringify(command)) throw new Error('Resolve your original walk-in before adding another.');
      if (!saved) await store.set(key, JSON.stringify(command));
      const outcome = await send(saved ?? command);
      if (outcome.ok || (outcome.failure.kind === 'rejected' && outcome.failure.reason !== 'request_reused')) await store.remove(key);
      return outcome;
    } finally { busy = false; }
  } };
}

export function walkInFailureMessage(f: WalkInFailure): string {
  if (f.kind === 'rejected') {
    const messages: Record<typeof WALK_IN_REJECTIONS[number], string> = {
      not_owner: 'You no longer manage this venue.', venue_unavailable: 'Walk-ins need a published venue with verified ownership.',
      session_not_found: 'This session is no longer available. Reload the list.', booking_not_found: 'This walk-in is no longer available. Reload the list.',
      session_full: 'Not enough spots left in this session.', group_limit_exceeded: 'Too many people for one group. Split them into smaller walk-ins.',
      stale_quote: 'The total changed. Reload the session and check the names again.', session_cancelled: 'This session was cancelled.',
      session_ended: 'This session has already ended.', invalid_transition: 'This walk-in can no longer be removed.',
      request_reused: 'This request key belongs to different walk-in details. Resolve the original walk-in first.',
      invalid_input: 'Enter 1–60 characters per name, one name per line, with no repeats.', invalid_request: 'Check the names and try again.',
    }; return messages[f.reason];
  }
  if (f.kind === 'rate_limited') return `Try again in ${f.retryAfterSeconds} seconds.`;
  if (f.kind === 'sign_in') return 'Sign in again, then retry the same walk-in.';
  if (f.kind === 'not_configured') return 'Walk-ins aren’t configured in this build.';
  return 'Couldn’t confirm the walk-in. Retry the original names to check its result safely.';
}
