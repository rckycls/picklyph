/**
 * T40a venue cancellations: a current owner cancels a future confirmed player rental or group, or a whole open-play
 * session, for one fixed reason. No money moves: arrival payments are recorded only from the start, and cancellation
 * closes at the start. See docs/venue-cancellations.md.
 */
export const CANCELLATION_REASONS = ['weather', 'maintenance', 'venue_closed', 'schedule_conflict', 'player_request', 'other'] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];
/** What the owner picks from. */
export const CANCELLATION_REASON_LABELS: Record<CancellationReason, string> = {
  weather: 'Weather',
  maintenance: 'Court maintenance',
  venue_closed: 'Venue closed',
  schedule_conflict: 'Schedule conflict',
  player_request: 'The player asked to cancel',
  other: 'Another reason',
};
/** Present on a booking read only when the venue cancelled it. */
export type VenueCancellation = { reason: CancellationReason; cancelled_at: string };
/** `rental-bookings` and `session-bookings` POST body. Never carries an actor: the server cancels as the verified caller. */
export type VenueCancelCommand = { kind: 'venue_cancel'; booking_id: string; reason: CancellationReason };

export class CancellationInputError extends Error {
  constructor() { super('Choose a booking and a cancellation reason.'); this.name = 'CancellationInputError'; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCancellationReason(value: unknown): value is CancellationReason {
  return (CANCELLATION_REASONS as readonly unknown[]).includes(value);
}
/** Strict `{kind:'venue_cancel', booking_id, reason}` and nothing else. */
export function readVenueCancel(raw: unknown): VenueCancelCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CancellationInputError();
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'booking_id,kind,reason' || input.kind !== 'venue_cancel'
    || typeof input.booking_id !== 'string' || !UUID.test(input.booking_id) || !isCancellationReason(input.reason)) throw new CancellationInputError();
  return { kind: 'venue_cancel', booking_id: input.booking_id.toLowerCase(), reason: input.reason };
}
/** How the player reads the reason, as the end of "<venue> cancelled your booking …". Null when it adds nothing. */
export function playerCancellationReason(reason: CancellationReason): string | null {
  switch (reason) {
    case 'weather': return 'because of the weather';
    case 'maintenance': return 'for court maintenance';
    case 'venue_closed': return 'because the venue is closed';
    case 'schedule_conflict': return 'because of a schedule conflict';
    case 'player_request': return 'at your request';
    case 'other': return null;
  }
}
