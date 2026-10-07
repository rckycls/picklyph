import { fromManilaDateTime, readRentalCommand, toManilaDateTime, type RentalBooking, type RentalBookingPage, type RentalQuote, type RentalRequest } from '@picklyph/domain';
import type { RentalFailure } from './client';

export function rentalWindow(courtId: string, date: string, time: string, duration: string) {
  if (!/^\d{2,4}$/.test(duration)) throw new Error('Use a duration in minutes.');
  const minutes = Number(duration);
  if (minutes < 60 || minutes > 1440 || minutes % 30) throw new Error('Choose 60–1440 minutes in 30-minute increments.');
  const starts_at = fromManilaDateTime({ date, time });
  if (Date.parse(starts_at) % 1800000) throw new Error('Start on the hour or half hour.');
  return { court_id: courtId, starts_at, ends_at: new Date(Date.parse(starts_at) + minutes * 60000).toISOString() };
}
export function defaultRentalDate() { return toManilaDateTime(new Date()).date; }
export function reviewedRequest(q: RentalQuote, requestId: string): RentalRequest {
  return readRentalCommand({ kind: 'request', court_id: q.court_id, starts_at: q.starts_at, ends_at: q.ends_at,
    request_id: requestId, expected_quote: q.expected_quote }) as RentalRequest;
}
/** Only a definitive transaction rejection permits a new quote/key. Transport/401/429 failures keep the original. */
export function canForgetAttempt(f: RentalFailure): boolean { return f.kind === 'rejected' && f.reason !== 'request_reused'; }
export const bookingStatus = (b: RentalBooking): { label: string; tone: 'success' | 'pending' | 'neutral' | 'error'; text: string } => {
  switch (b.status) {
    case 'pending': return { label: 'Awaiting approval', tone: 'pending', text: 'Your court is held while the venue decides. It is not confirmed yet.' };
    case 'confirmed': return { label: 'Confirmed', tone: 'success', text: 'Your court reservation is confirmed. Payment is still due at the venue.' };
    case 'expired': return { label: 'Expired', tone: 'neutral', text: 'The approval hold ended. This booking no longer reserves the court.' };
    case 'declined': return { label: 'Declined', tone: 'error', text: 'The venue declined this request. This booking no longer reserves the court.' };
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral', text: 'This booking is cancelled and no longer reserves the court.' };
  }
};
export function mergeHistory(existing: RentalBooking[], page: RentalBookingPage, after: string | null): RentalBooking[] {
  const rows = after ? [...existing, ...page.bookings] : page.bookings;
  return [...new Map(rows.map((b) => [b.id, b])).values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}
/** Increment on identity changes, input edits and refresh: late replies cannot revive older state. */
export function createGeneration() {
  let value = 0;
  return { next: () => ++value, current: (generation: number) => generation === value };
}
