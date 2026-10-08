import { fromManilaDateTime, pesosToCentavos, readSessionCreate, type SessionCreate } from '@picklyph/domain';
import { addDays } from './calendarModel';
/** Civil-minute conversion is separate from the human-facing 12-hour clock labels. */
export function sessionDraft(input: { venueId: string; requestId: string; courts: string[]; title: string; date: string;
  start: number; end: number; capacity: string; group: string; price: string }): SessionCreate {
  const instant = (minute: number) => {
    if (!Number.isInteger(minute) || minute < 0 || minute > 2880) throw new Error('Invalid session time');
    const time = `${String(Math.floor((minute % 1440) / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    return fromManilaDateTime({ date: addDays(input.date, Math.floor(minute / 1440)), time });
  };
  return readSessionCreate({ venue_id: input.venueId, request_id: input.requestId, court_ids: input.courts, title: input.title,
    starts_at: instant(input.start), ends_at: instant(input.end), capacity: Number(input.capacity), group_limit: Number(input.group),
    price_centavos: pesosToCentavos(input.price) });
}
