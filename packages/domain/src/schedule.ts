import { fromManilaDateTime } from './booking.ts';
import { isPhpCentavos } from './money.ts';

/** Minutes from the opening day's Manila midnight; an overnight end exceeds 1440. */
export type RateBand = { start_minute: number; end_minute: number; hourly_centavos: number };
export type OpeningWindow = { start_minute: number; end_minute: number; rates: RateBand[] };
export type ScheduleException = { date: string; windows: OpeningWindow[] };
/** Sunday=0. An empty array closes that opening day; exceptions replace the entire civil date. */
export type VenueSchedule = { weekly: OpeningWindow[][]; exceptions: ScheduleException[] };
export type ScheduleInterval = { starts_at: string; ends_at: string; hourly_centavos: number };
export type ScheduleView = { venue_id: string; revision: string | null; schedule: VenueSchedule | null; intervals: ScheduleInterval[] };
export type ScheduleSave = { venue_id: string; expected_revision: string | null; schedule: VenueSchedule };

export class ScheduleInputError extends Error {
  constructor() { super('Check the opening hours, rates and exceptions.'); this.name = 'ScheduleInputError'; }
}

function object(raw: unknown, keys: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== keys) throw new ScheduleInputError();
  return raw as Record<string, unknown>;
}
function minute(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 2880 || raw % 30) throw new ScheduleInputError();
  return raw;
}
/** Bounded contemporary dates shared with SQL; no host-local Date parsing. */
export function scheduleDate(raw: unknown): string {
  if (typeof raw !== 'string' || !/^(20\d\d)-\d\d-\d\d$/.test(raw)) throw new ScheduleInputError();
  try { fromManilaDateTime({ date: raw, time: '00:00' }); } catch { throw new ScheduleInputError(); }
  return raw;
}
function dateShift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
function windows(raw: unknown): OpeningWindow[] {
  if (!Array.isArray(raw) || raw.length > 4) throw new ScheduleInputError();
  let previousEnd = -1;
  return raw.map((item) => {
    const w = object(item, 'end_minute,rates,start_minute');
    const start = minute(w.start_minute); const end = minute(w.end_minute);
    if (start >= 1440 || end <= start || end - start > 1440 || start < previousEnd) throw new ScheduleInputError();
    previousEnd = end;
    if (!Array.isArray(w.rates) || w.rates.length < 1 || w.rates.length > 16) throw new ScheduleInputError();
    let cursor = start;
    const rates = w.rates.map((item): RateBand => {
      const r = object(item, 'end_minute,hourly_centavos,start_minute');
      const a = minute(r.start_minute); const b = minute(r.end_minute);
      if (a !== cursor || b <= a || b > end || typeof r.hourly_centavos !== 'number' || !isPhpCentavos(r.hourly_centavos)) throw new ScheduleInputError();
      cursor = b;
      return { start_minute: a, end_minute: b, hourly_centavos: r.hourly_centavos };
    });
    if (cursor !== end) throw new ScheduleInputError();
    return { start_minute: start, end_minute: end, rates };
  });
}
function effective(schedule: VenueSchedule, date: string): RateBand[] {
  const exception = schedule.exceptions.find((e) => e.date === date);
  const dayWindows = (d: string) => schedule.exceptions.find((e) => e.date === d)?.windows
    ?? schedule.weekly[new Date(`${d}T00:00:00Z`).getUTCDay()]!;
  const today = dayWindows(date).flatMap((w) => w.rates).filter((r) => r.start_minute < 1440)
    .map((r) => ({ ...r, end_minute: Math.min(r.end_minute, 1440) }));
  // An exception governs its whole civil date, including spill-in from yesterday.
  const spill = exception ? [] : dayWindows(dateShift(date, -1)).flatMap((w) => w.rates).filter((r) => r.end_minute > 1440)
    .map((r) => ({ ...r, start_minute: Math.max(r.start_minute - 1440, 0), end_minute: r.end_minute - 1440 }));
  return [...spill, ...today].sort((a, b) => a.start_minute - b.start_minute);
}
export function readVenueSchedule(raw: unknown): VenueSchedule {
  const s = object(raw, 'exceptions,weekly');
  if (!Array.isArray(s.weekly) || s.weekly.length !== 7 || !Array.isArray(s.exceptions) || s.exceptions.length > 120) throw new ScheduleInputError();
  const seen = new Set<string>();
  const schedule: VenueSchedule = { weekly: s.weekly.map(windows), exceptions: s.exceptions.map((item) => {
    const e = object(item, 'date,windows'); const date = scheduleDate(e.date);
    if (seen.has(date)) throw new ScheduleInputError();
    seen.add(date); return { date, windows: windows(e.windows) };
  }).sort((a, b) => a.date.localeCompare(b.date)) };
  // Check the cyclic weekly boundary plus every date affected by an override.
  const weeklyOnly = { ...schedule, exceptions: [] };
  const check = (rules: VenueSchedule, date: string) => {
    let end = -1;
    for (const r of effective(rules, date)) {
      if (r.start_minute < end) throw new ScheduleInputError();
      end = r.end_minute;
    }
  };
  for (let day = 0; day < 7; day++) check(weeklyOnly, dateShift('2026-01-04', day));
  for (const e of schedule.exceptions) { check(schedule, e.date); check(schedule, dateShift(e.date, 1)); }
  return schedule;
}
/** Half-open UTC intervals clipped to the requested Manila civil dates, split at rates/midnight. */
export function resolveVenueSchedule(raw: VenueSchedule, startDate: string, days: number): ScheduleInterval[] {
  const schedule = readVenueSchedule(raw); const date = scheduleDate(startDate);
  if (!Number.isInteger(days) || days < 1 || days > 31 || dateShift(date, days - 1) > '2099-12-31') throw new ScheduleInputError();
  const intervals: ScheduleInterval[] = [];
  for (let i = 0; i < days; i++) {
    const current = dateShift(date, i);
    const midnight = Date.parse(fromManilaDateTime({ date: current, time: '00:00' }));
    for (const r of effective(schedule, current)) intervals.push({
      starts_at: new Date(midnight + r.start_minute * 60000).toISOString(),
      ends_at: new Date(midnight + r.end_minute * 60000).toISOString(), hourly_centavos: r.hourly_centavos,
    });
  }
  return intervals;
}
function venueId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new ScheduleInputError();
  return raw.toLowerCase();
}
export function readScheduleSave(raw: unknown): ScheduleSave {
  const s = object(raw, 'expected_revision,schedule,venue_id');
  const revision = s.expected_revision;
  if (revision !== null && (typeof revision !== 'string' || !/^[1-9]\d{0,15}$/.test(revision))) throw new ScheduleInputError();
  return { venue_id: venueId(s.venue_id), expected_revision: revision, schedule: readVenueSchedule(s.schedule) };
}
export function readScheduleQuery(params: URLSearchParams): { venue_id: string; start_date: string; days: number } {
  if ([...params.keys()].sort().join(',') !== 'days,start_date,venue_id' || !/^(?:[1-9]|[12]\d|3[01])$/.test(params.get('days') ?? '')) throw new ScheduleInputError();
  const start_date = scheduleDate(params.get('start_date')); const days = Number(params.get('days'));
  if (dateShift(start_date, days - 1) > '2099-12-31') throw new ScheduleInputError();
  return { venue_id: venueId(params.get('venue_id')), start_date, days };
}
