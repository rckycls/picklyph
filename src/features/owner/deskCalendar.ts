import { minutesFrom } from '@/components/calendar/dates';

import type { DeskBooking } from './deskClient';

// Pure front-desk timeline: the day's confirmed bookings placed on court columns. Rentals sit on
// their court; a session's groups share one entry on each of its courts.
type Placement = { start: number; end: number; continuesBefore: boolean; continuesAfter: boolean };
export type DeskEntry = Placement & (
  | { kind: 'rental'; key: string; courtIds: [string]; items: [DeskBooking] }
  | { kind: 'session'; key: string; courtIds: string[]; items: DeskBooking[] }
);
export type DeskTone = 'rental' | 'session' | 'done' | 'muted';
export type DeskSummary = { bookings: number; arrived: number; paidCentavos: number; dueCentavos: number };

function place(date: string, startsAt: string, endsAt: string): Placement {
  const start = minutesFrom(date, startsAt); const end = minutesFrom(date, endsAt);
  return { start: Math.max(0, start), end: Math.min(1440, end), continuesBefore: start < 0, continuesAfter: end > 1440 };
}

export function deskEntries(date: string, bookings: readonly DeskBooking[]): DeskEntry[] {
  const entries: DeskEntry[] = [];
  const sessions = new Map<string, { snapshot: { court_ids: string[]; starts_at: string; ends_at: string }; items: DeskBooking[] }>();
  for (const item of bookings) {
    if (item.kind === 'rental') {
      const a = item.booking.allocation;
      entries.push({ kind: 'rental', key: item.booking.id, courtIds: [a.court_id], items: [item], ...place(date, a.starts_at, a.ends_at) });
    } else {
      const session = sessions.get(item.booking.session_id) ?? { snapshot: item.booking.snapshot, items: [] };
      session.items.push(item); sessions.set(item.booking.session_id, session);
    }
  }
  for (const [sessionId, { snapshot, items }] of sessions) {
    entries.push({ kind: 'session', key: sessionId, courtIds: [...snapshot.court_ids], items, ...place(date, snapshot.starts_at, snapshot.ends_at) });
  }
  return entries.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}

const arrived = (item: DeskBooking) => ['checked_in', 'completed'].includes(item.booking.operations.attendance);
/** Green once everyone has arrived, grey when every booking was a no-show. */
export function entryTone(entry: DeskEntry): DeskTone {
  if (entry.items.every(arrived)) return 'done';
  if (entry.items.every((item) => item.booking.operations.attendance === 'no_show')) return 'muted';
  return entry.kind;
}
export function deskSummary(bookings: readonly DeskBooking[]): DeskSummary {
  let paidCentavos = 0; let dueCentavos = 0;
  for (const item of bookings) {
    const ops = item.booking.operations;
    if (ops.payment) paidCentavos += ops.payment.amount_centavos;
    else if (ops.attendance !== 'no_show') dueCentavos += item.booking.snapshot.total_centavos;
  }
  return { bookings: bookings.length, arrived: bookings.filter(arrived).length, paidCentavos, dueCentavos };
}
