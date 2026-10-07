import type { RentalBooking } from '@picklyph/domain';

/** Ephemeral presentation only. Booking authority always comes from fresh server responses. */
export function createCelebrations() {
  const requested = new Set<string>();
  const celebrated = new Set<string>();
  const observed = new Map<string, RentalBooking['status']>();
  const key = (actor: string, booking: RentalBooking) => `${actor}:${booking.id}`;
  return {
    requested(actor: string, booking: RentalBooking) {
      const id = key(actor, booking);
      if (booking.status === 'confirmed' || booking.status === 'pending') requested.add(id);
      if (booking.status === 'pending') observed.set(id, 'pending');
    },
    observe(actor: string, booking: RentalBooking, fresh: boolean) {
      if (!fresh) return false;
      const id = key(actor, booking);
      const previous = observed.get(id);
      observed.set(id, booking.status);
      if (booking.status !== 'confirmed') {
        if (booking.status !== 'pending') requested.delete(id);
        return false;
      }
      const newlyConfirmed = requested.has(id) || previous === 'pending';
      requested.delete(id);
      if (!newlyConfirmed || celebrated.has(id)) return false;
      celebrated.add(id);
      return true;
    },
  };
}

export const rentalCelebrations = createCelebrations();
