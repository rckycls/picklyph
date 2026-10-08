import { formatPhpCentavos, readParticipantNames, readSessionBookingCommand, sessionGroupTotal,
  type SessionBooking, type SessionBookingRequest, type SessionOffer } from '@picklyph/domain';
import type { GroupFailure } from './client';

/** Only a definitive transaction rejection permits a new key. Transport/401/429/503 failures keep the original. */
export const canForgetGroupAttempt = (f: GroupFailure): boolean => f.kind === 'rejected' && f.reason !== 'request_reused';

export type OfferState = 'open' | 'full' | 'started' | 'cancelled';
/** `at` is the database time of the read that returned the offer, never the device clock. */
export function offerState(offer: SessionOffer, at: string): OfferState {
  if (offer.status === 'cancelled') return 'cancelled';
  if (Date.parse(offer.snapshot.starts_at) <= Date.parse(at)) return 'started';
  return offer.available_spots > 0 ? 'open' : 'full';
}
export function spotsLabel(offer: SessionOffer, at: string): string {
  const state = offerState(offer, at);
  if (state === 'cancelled') return 'Cancelled';
  if (state === 'started') return 'Started';
  if (state === 'full') return `Full · ${offer.snapshot.capacity} spots`;
  return `${offer.available_spots} of ${offer.snapshot.capacity} ${offer.snapshot.capacity === 1 ? 'spot' : 'spots'} left`;
}
/** The most name rows worth offering: the group limit, capped by spots left at the last read. The server re-checks both. */
export function maxGroupRows(offer: SessionOffer): number {
  return Math.max(1, Math.min(offer.snapshot.group_limit, offer.available_spots));
}
export function groupNames(rows: readonly string[]): string[] { return rows.map((row) => row.trim()).filter(Boolean); }

export type GroupPreview = { ok: true; names: string[]; total_centavos: number; text: string } | { ok: false; text: string };
/** Local guidance before reserving. The total is the immutable per-person price × names; the server repeats every check. */
export function groupPreview(offer: SessionOffer, at: string, rows: readonly string[]): GroupPreview {
  const state = offerState(offer, at); const snap = offer.snapshot;
  if (state === 'cancelled') return { ok: false, text: 'The venue cancelled this session.' };
  if (state === 'started') return { ok: false, text: 'This session has started. Groups can join only before the start.' };
  if (state === 'full') return { ok: false, text: 'This session is full.' };
  if (snap.policy.payment === 'online') return { ok: false, text: 'This session takes online payment only. Pay-at-venue groups aren’t offered.' };
  const names = groupNames(rows);
  if (!names.length) return { ok: false, text: 'Enter at least one name.' };
  if (names.length > snap.group_limit) return { ok: false, text: `Up to ${snap.group_limit} ${snap.group_limit === 1 ? 'person' : 'people'} per group in this session.` };
  if (names.length > offer.available_spots) return { ok: false, text: `Only ${offer.available_spots} ${offer.available_spots === 1 ? 'spot' : 'spots'} left.` };
  try { readParticipantNames(names); } catch { return { ok: false, text: 'Use 1–60 characters per name, with no repeated names.' }; }
  const total = sessionGroupTotal(snap.price_centavos, names.length);
  return { ok: true, names, total_centavos: total,
    text: `${names.length} ${names.length === 1 ? 'person' : 'people'} × ${formatPhpCentavos(snap.price_centavos)} = ${formatPhpCentavos(total)}` };
}
export function groupRequest(offer: SessionOffer, names: readonly string[], requestId: string): SessionBookingRequest {
  return readSessionBookingCommand({ kind: 'request', session_id: offer.id, request_id: requestId, participants: [...names],
    expected_total_centavos: sessionGroupTotal(offer.snapshot.price_centavos, names.length) }) as SessionBookingRequest;
}
export const groupStatus = (b: SessionBooking): { label: string; tone: 'success' | 'pending' | 'neutral' | 'error'; text: string } => {
  switch (b.status) {
    case 'pending': return { label: 'Awaiting approval', tone: 'pending', text: 'Your group’s spots are held while the venue decides. It is not confirmed yet.' };
    case 'confirmed': return { label: 'Confirmed', tone: 'success', text: 'Your group’s spots are confirmed. Payment is still due at the venue.' };
    case 'expired': return { label: 'Expired', tone: 'neutral', text: 'The approval hold ended. This group no longer holds spots.' };
    case 'declined': return { label: 'Declined', tone: 'error', text: 'The venue declined this request. This group no longer holds spots.' };
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral', text: 'This group is cancelled and no longer holds spots.' };
  }
};
