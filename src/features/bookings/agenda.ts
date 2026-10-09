import type { RentalBooking, SessionBooking } from '@picklyph/domain';

import { manilaParts } from '@/components/calendar/dates';

// Pure calendar view of a player's own rentals and open-play groups (loaded history pages only).
export type BookingStatus = RentalBooking['status'];
export type PlayerEntry = {
  kind: 'rental' | 'group'; id: string; venueId: string; courtIds: string[]; title: string | null;
  startsAt: string; endsAt: string; date: string; start: number; end: number;
  status: BookingStatus; spots: number; durationMinutes: number; totalCentavos: number;
};

/** Pending and confirmed bookings still hold court time or spots; the rest are history. */
export const isLive = (entry: Pick<PlayerEntry, 'status'>) => entry.status === 'pending' || entry.status === 'confirmed';

export function playerEntries(rentals: readonly RentalBooking[], groups: readonly SessionBooking[]): PlayerEntry[] {
  const entry = (base: Omit<PlayerEntry, 'date' | 'start' | 'end' | 'durationMinutes'>): PlayerEntry => {
    const start = manilaParts(base.startsAt);
    const durationMinutes = Math.round((Date.parse(base.endsAt) - Date.parse(base.startsAt)) / 60_000);
    return { ...base, date: start.date, start: start.minute, end: start.minute + durationMinutes, durationMinutes };
  };
  return [
    ...rentals.map((b) => entry({ kind: 'rental', id: b.id, venueId: b.allocation.venue_id, courtIds: [b.allocation.court_id], title: null,
      startsAt: b.snapshot.starts_at, endsAt: b.snapshot.ends_at, status: b.status, spots: 0, totalCentavos: b.snapshot.total_centavos })),
    ...groups.map((b) => entry({ kind: 'group', id: b.id, venueId: b.snapshot.venue_id, courtIds: [...b.snapshot.court_ids], title: b.snapshot.title,
      startsAt: b.snapshot.starts_at, endsAt: b.snapshot.ends_at, status: b.status, spots: b.spots, totalCentavos: b.snapshot.total_centavos })),
  ].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
}
/** Dots for days with live bookings; a day with a pending request needs attention. */
export function playerMarks(entries: readonly PlayerEntry[]): Map<string, 'busy' | 'attention'> {
  const marks = new Map<string, 'busy' | 'attention'>();
  for (const entry of entries) {
    if (!isLive(entry)) continue;
    if (entry.status === 'pending') marks.set(entry.date, 'attention');
    else if (!marks.has(entry.date)) marks.set(entry.date, 'busy');
  }
  return marks;
}
/** Live bookings that haven't ended, soonest first. */
export function upcoming(entries: readonly PlayerEntry[], now: number, limit: number): PlayerEntry[] {
  return entries.filter((entry) => isLive(entry) && Date.parse(entry.endsAt) > now).slice(0, limit);
}
