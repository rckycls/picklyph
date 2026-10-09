import {
  ALLOCATION_INCREMENT_MINUTES, fromManilaDateTime, toManilaDateTime,
  type AllocationBlock, type AllocationKind, type CalendarView,
} from '@picklyph/domain';

// Pure Manila-day view of one court for the owner calendar. Minutes count from the
// date's Manila midnight (UTC+8, no daylight saving); 1440 is the next midnight.
export const DAY_MINUTES = 1440;
const STEP = ALLOCATION_INCREMENT_MINUTES;
const MINUTE_MS = 60_000;

export type Span = { start: number; end: number };
export type AgendaItem = Span & {
  id: string; kind: AllocationKind; label: string;
  /** The allocation continues before/after this day. */
  fromPreviousDay: boolean; toNextDay: boolean;
  /** Hold expiry as a Manila clock label, or null for firm inventory. */
  heldUntil: string | null;
  /** Owners release their blocks here; rentals and sessions change through their bookings. */
  releasable: boolean;
};
export type CourtDay = {
  courtId: string; name: string; active: boolean;
  /** Merged open hours for this day (rate changes don't split them here). */
  open: Span[];
  items: AgendaItem[];
  /** Open, unallocated and not yet past: where a block can start. */
  free: Span[];
  closedReason: 'closure' | 'no_hours' | null;
};

const KIND_LABELS: Record<AllocationKind, string> = { block: 'Blocked', rental: 'Court rental', session: 'Open play' };

export function manilaDate(at: string | number | Date): string {
  return toManilaDateTime(at).date;
}
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
const dayFormat = new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
/** "Thursday, Oct 8" for a Manila civil date (formatted as a plain date, never shifted). */
export function dayTitle(date: string): string {
  return dayFormat.format(new Date(`${date}T00:00:00Z`));
}
/** "6:30 AM"; 1440 is "midnight"; later minutes are marked as the next day. */
export function clockLabel(minute: number): string {
  if (minute === DAY_MINUTES) return 'midnight';
  const within = minute % DAY_MINUTES; const hour = Math.floor(within / 60); const min = within % 60;
  const label = `${hour % 12 === 0 ? 12 : hour % 12}:${String(min).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  return minute > DAY_MINUTES ? `${label} (next day)` : label;
}
export function spanLabel(span: Span): string {
  return `${clockLabel(span.start)} – ${clockLabel(span.end)}`;
}
function manilaClock(at: string): string {
  const [hour, minute] = toManilaDateTime(at).time.split(':').map(Number);
  return clockLabel(hour! * 60 + minute!);
}
function midnight(date: string): number {
  return Date.parse(fromManilaDateTime({ date, time: '00:00' }));
}
function clip(startMs: number, endMs: number, dayStart: number): Span | null {
  const start = Math.max(0, Math.floor((startMs - dayStart) / MINUTE_MS));
  const end = Math.min(DAY_MINUTES, Math.ceil((endMs - dayStart) / MINUTE_MS));
  return start < end ? { start, end } : null;
}
function subtract(spans: Span[], taken: Span[]): Span[] {
  let result = spans;
  for (const t of taken) result = result.flatMap((s) => {
    if (t.end <= s.start || t.start >= s.end) return [s];
    return [{ start: s.start, end: t.start }, { start: t.end, end: s.end }].filter((x) => x.start < x.end);
  });
  return result;
}

/** One court's day from a single calendar snapshot; `view.at` is the server clock. */
export function courtDay(view: CalendarView, courtId: string, date: string): CourtDay {
  const court = view.courts.find((c) => c.court_id === courtId);
  if (!court) throw new Error('Unknown court.');
  const dayStart = midnight(date);
  const open: Span[] = [];
  for (const interval of court.intervals) {
    const span = clip(Date.parse(interval.starts_at), Date.parse(interval.ends_at), dayStart);
    if (!span) continue;
    const last = open[open.length - 1];
    if (last && last.end === span.start) last.end = span.end; else open.push(span);
  }
  const items = view.allocations.filter((a) => a.court_id === courtId).flatMap((a): AgendaItem[] => {
    const startMs = Date.parse(a.starts_at); const endMs = Date.parse(a.ends_at);
    const span = clip(startMs, endMs, dayStart);
    if (!span) return [];
    return [{ ...span, id: a.id, kind: a.kind, label: KIND_LABELS[a.kind], fromPreviousDay: startMs < dayStart,
      toNextDay: endMs > dayStart + DAY_MINUTES * MINUTE_MS,
      heldUntil: a.expires_at === null ? null : manilaClock(a.expires_at),
      releasable: a.kind === 'block' }];
  }).sort((x, y) => x.start - y.start);
  // Blocks must end in the future; start choices begin at the next half hour.
  const now = Date.parse(view.at);
  const earliest = Math.max(0, Math.ceil((now - dayStart) / MINUTE_MS / STEP) * STEP);
  const free = subtract(open, [...items, { start: 0, end: Math.min(earliest, DAY_MINUTES) }]);
  const closedReason = court.hours.closures.includes(date) ? 'closure' : open.length === 0 ? 'no_hours' : null;
  return { courtId, name: court.name, active: court.status === 'active', open, items, free, closedReason };
}

/** Every half hour where at least a 30-minute block fits. */
export function startOptions(free: Span[]): number[] {
  return free.flatMap((span) => {
    const options: number[] = [];
    for (let m = Math.ceil(span.start / STEP) * STEP; m + STEP <= span.end; m += STEP) options.push(m);
    return options;
  });
}
/** End choices for a start: up to the end of its free span (blocks stay within the day). */
export function endOptions(free: Span[], start: number): number[] {
  const span = free.find((s) => s.start <= start && start < s.end);
  if (!span) return [];
  const options: number[] = [];
  for (let m = start + STEP; m <= span.end; m += STEP) options.push(m);
  return options;
}
/** The Monday-to-Sunday week holding `date`, clipped to the server's 2000–2099 calendar range (at most 7 days). */
export function weekSpan(date: string): { start: string; days: number } {
  const monday = addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
  const start = monday < '2000-01-01' ? '2000-01-01' : monday;
  const sunday = addDays(monday, 6); const last = sunday > '2099-12-31' ? '2099-12-31' : sunday;
  return { start, days: Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1 };
}
/** Week-strip dots: days with rentals or open play; a pending request's hold marks its day for attention. Blocks are not bookings. */
export function calendarMarks(view: CalendarView): Map<string, 'busy' | 'attention'> {
  const marks = new Map<string, 'busy' | 'attention'>();
  for (const allocation of view.allocations) {
    if (allocation.kind === 'block') continue;
    const date = manilaDate(allocation.starts_at);
    if (allocation.expires_at !== null) marks.set(date, 'attention');
    else if (!marks.has(date)) marks.set(date, 'busy');
  }
  return marks;
}
/** Minutes from the date's Manila midnight to an instant (the server clock for the "now" line). */
export function minuteOfDay(date: string, at: string): number {
  return Math.floor((Date.parse(at) - midnight(date)) / MINUTE_MS);
}
/** A start option for a tapped slot and a default end one hour later (or the longest that fits). */
export function slotForm(free: Span[], start: number): Span | null {
  if (!startOptions(free).includes(start)) return null;
  const ends = endOptions(free, start);
  return { start, end: ends[Math.min(1, ends.length - 1)]! };
}
export function blockCommand(courtId: string, date: string, span: Span, requestId: string): AllocationBlock {
  const dayStart = midnight(date);
  return { court_id: courtId, request_id: requestId,
    starts_at: new Date(dayStart + span.start * MINUTE_MS).toISOString(), ends_at: new Date(dayStart + span.end * MINUTE_MS).toISOString() };
}
