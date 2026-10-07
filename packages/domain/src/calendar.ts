import { readAllocationBlock, type AllocationBlock, type CourtAllocation } from './allocation.ts';
import { fromManilaDateTime, toManilaDateTime } from './booking.ts';
import type { CourtStatus } from './directory.ts';
import { readScheduleSave, resolveVenueSchedule, scheduleDate, type ScheduleInterval, type ScheduleSave, type VenueSchedule } from './schedule.ts';

export const MAX_CALENDAR_DAYS = 7;
export const MAX_COURT_WINDOWS = 4;
export const MAX_COURT_CLOSURES = 120;

/** Same-day court window in minutes from Manila midnight; 1440 is the next midnight. */
export type CourtWindow = { start_minute: number; end_minute: number };
/** Court rules only narrow venue hours. `weekly` null follows the venue's weekly hours; closures close whole Manila dates. */
export type CourtHours = { weekly: CourtWindow[][] | null; closures: string[] };
export type CourtHoursView = { court_id: string; revision: string | null; hours: CourtHours };
export type CourtHoursSave = { court_id: string; expected_revision: string | null; hours: CourtHours };
export type CalendarCourt = CourtHoursView & { name: string; status: CourtStatus; intervals: ScheduleInterval[] };
/** One server snapshot: courts, their resolved hours and live inventory at the server clock `at`. */
export type CalendarView = {
  venue_id: string; name: string; start_date: string; days: number; at: string;
  schedule_revision: string | null; courts: CalendarCourt[]; allocations: CourtAllocation[];
};
export type CalendarQuery = { venue_id: string; start_date: string; days: number };
/** owner-schedules POST bodies. A body without `kind` is the T19 venue schedule save. */
export type ScheduleCommand =
  | { kind: 'save_schedule'; command: ScheduleSave }
  | { kind: 'block'; command: AllocationBlock }
  | { kind: 'release_block'; command: { allocation_id: string } }
  | { kind: 'save_court_hours'; command: CourtHoursSave };

export class CalendarInputError extends Error {
  constructor() { super('Check the court hours and dates.'); this.name = 'CalendarInputError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(raw: unknown, keys: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== keys) throw new CalendarInputError();
  return raw as Record<string, unknown>;
}
function uuid(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw new CalendarInputError();
  return raw.toLowerCase();
}
function minute(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 1440 || raw % 30) throw new CalendarInputError();
  return raw;
}
function date(raw: unknown): string {
  try { return scheduleDate(raw); } catch { throw new CalendarInputError(); }
}
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** Mirrors SQL: sorted, disjoint (adjacent allowed) same-day windows; unique closures. */
export function readCourtHours(raw: unknown): CourtHours {
  const h = object(raw, 'closures,weekly');
  if (h.weekly !== null && (!Array.isArray(h.weekly) || h.weekly.length !== 7)) throw new CalendarInputError();
  if (!Array.isArray(h.closures) || h.closures.length > MAX_COURT_CLOSURES) throw new CalendarInputError();
  const weekly = h.weekly === null ? null : h.weekly.map((day: unknown) => {
    if (!Array.isArray(day) || day.length > MAX_COURT_WINDOWS) throw new CalendarInputError();
    let previousEnd = -1;
    return day.map((item): CourtWindow => {
      const w = object(item, 'end_minute,start_minute');
      const start = minute(w.start_minute); const end = minute(w.end_minute);
      if (start >= 1440 || end <= start || start < previousEnd) throw new CalendarInputError();
      previousEnd = end;
      return { start_minute: start, end_minute: end };
    });
  });
  const closures = h.closures.map(date);
  if (new Set(closures).size !== closures.length) throw new CalendarInputError();
  return { weekly, closures: closures.sort() };
}
export function readCourtHoursSave(raw: unknown): CourtHoursSave {
  const s = object(raw, 'court_id,expected_revision,hours');
  const revision = s.expected_revision;
  if (revision !== null && (typeof revision !== 'string' || !/^[1-9]\d{0,15}$/.test(revision))) throw new CalendarInputError();
  return { court_id: uuid(s.court_id), expected_revision: revision, hours: readCourtHours(s.hours) };
}
export function readCalendarQuery(params: URLSearchParams): CalendarQuery {
  if ([...params.keys()].sort().join(',') !== 'days,section,start_date,venue_id' || params.get('section') !== 'calendar'
    || !/^[1-7]$/.test(params.get('days') ?? '')) throw new CalendarInputError();
  const start_date = date(params.get('start_date')); const days = Number(params.get('days'));
  if (shift(start_date, days - 1) > '2099-12-31') throw new CalendarInputError();
  return { venue_id: uuid(params.get('venue_id')), start_date, days };
}
/** Strict dispatch: each kind has exact keys; the actor always comes from verified Auth. */
export function readScheduleCommand(raw: unknown): ScheduleCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CalendarInputError();
  if (!Object.hasOwn(raw, 'kind')) return { kind: 'save_schedule', command: readScheduleSave(raw) };
  const { kind, ...rest } = raw as Record<string, unknown>;
  switch (kind) {
    case 'block': return { kind, command: readAllocationBlock(rest) };
    case 'release_block': return { kind, command: { allocation_id: uuid(object(rest, 'allocation_id').allocation_id) } };
    case 'save_court_hours': return { kind, command: readCourtHoursSave(rest) };
    default: throw new CalendarInputError();
  }
}

/** Court-local open minutes of one Manila date (SQL `private.court_day_ranges`). */
export function courtDayRanges(hours: CourtHours, day: string): CourtWindow[] {
  if (hours.closures.includes(day)) return [];
  if (!hours.weekly) return [{ start_minute: 0, end_minute: 1440 }];
  return hours.weekly[new Date(`${day}T00:00:00Z`).getUTCDay()]!;
}
/** Venue intervals intersected with court ranges for the same civil date; venue rates kept (SQL `private.resolve_court_hours`). */
export function resolveCourtHours(schedule: VenueSchedule, raw: CourtHours, startDate: string, days: number): ScheduleInterval[] {
  const hours = readCourtHours(raw);
  const intervals: ScheduleInterval[] = [];
  for (const interval of resolveVenueSchedule(schedule, startDate, days)) {
    const start = Date.parse(interval.starts_at); const end = Date.parse(interval.ends_at);
    const day = toManilaDateTime(start).date;
    const midnight = Date.parse(fromManilaDateTime({ date: day, time: '00:00' }));
    for (const range of courtDayRanges(hours, day)) {
      const a = Math.max(start, midnight + range.start_minute * 60000); const b = Math.min(end, midnight + range.end_minute * 60000);
      if (a < b) intervals.push({ starts_at: new Date(a).toISOString(), ends_at: new Date(b).toISOString(), hourly_centavos: interval.hourly_centavos });
    }
  }
  return intervals.sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at));
}
