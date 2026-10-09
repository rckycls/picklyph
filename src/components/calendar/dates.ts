// Pure civil-date helpers for calendar screens. Dates are Manila `YYYY-MM-DD` strings handled
// as UTC midnights, so the device time zone never shifts them. Manila is UTC+8 with no daylight
// saving, which also makes instant → Manila conversion a fixed offset.
export const MIN_DATE = '2000-01-01';
export const MAX_DATE = '2099-12-31';
const DAY_MS = 86_400_000;
const MANILA_OFFSET_MS = 8 * 3_600_000;

const parse = (date: string) => Date.parse(`${date}T00:00:00Z`);
const format = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function shiftDays(date: string, days: number): string {
  return format(parse(date) + days * DAY_MS);
}
export function clampDate(date: string, min = MIN_DATE, max = MAX_DATE): string {
  return date < min ? min : date > max ? max : date;
}
/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / DAY_MS);
}
/** Monday of the date's week. */
export function startOfWeek(date: string): string {
  return shiftDays(date, -((new Date(parse(date)).getUTCDay() + 6) % 7));
}
/** Monday to Sunday. */
export function weekOf(date: string): string[] {
  const first = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => shiftDays(first, i));
}
export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}
export function shiftMonths(date: string, months: number): string {
  const first = new Date(parse(startOfMonth(date)));
  first.setUTCMonth(first.getUTCMonth() + months);
  return format(first.getTime());
}
/** Monday-first weeks covering the date's month (four to six rows). */
export function monthWeeks(date: string): string[][] {
  const next = shiftMonths(date, 1);
  const weeks: string[][] = [];
  for (let start = startOfWeek(startOfMonth(date)); start < next; start = shiftDays(start, 7)) weeks.push(weekOf(start));
  return weeks;
}
export const sameMonth = (a: string, b: string) => a.slice(0, 7) === b.slice(0, 7);
export const dayOfMonth = (date: string) => Number(date.slice(8, 10));

/** An instant's Manila civil date and minute of that day (0–1439). */
export function manilaParts(at: string | number): { date: string; minute: number } {
  const shifted = new Date((typeof at === 'number' ? at : Date.parse(at)) + MANILA_OFFSET_MS);
  return { date: shifted.toISOString().slice(0, 10), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}
/** Minutes from the date's Manila midnight; negative before it, past 1440 after it. */
export function minutesFrom(date: string, at: string | number): number {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return Math.floor((ms - (parse(date) - MANILA_OFFSET_MS)) / 60_000);
}
/** "6:30 PM" for a minute of the day; 1440 reads as midnight again. */
export function clockText(minute: number): string {
  const within = ((minute % 1440) + 1440) % 1440;
  const hour = Math.floor(within / 60); const min = within % 60;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(min).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}
/** "6 PM" for whole hours, used by timeline gutters. */
export function hourText(minute: number): string {
  const hour = Math.floor((((minute % 1440) + 1440) % 1440) / 60);
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

const formatter = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', ...options });
const monthFormat = formatter({ month: 'long', year: 'numeric' });
const weekdayFormat = formatter({ weekday: 'short' });
const shortFormat = formatter({ weekday: 'short', month: 'short', day: 'numeric' });
const monthDayFormat = formatter({ month: 'short', day: 'numeric' });
const longFormat = formatter({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const asDate = (date: string) => new Date(parse(date));

/** "October 2026" */
export const monthTitle = (date: string) => monthFormat.format(asDate(date));
/** "Mon" */
export const weekdayText = (date: string) => weekdayFormat.format(asDate(date));
/** "Fri, Oct 9" */
export const shortDateText = (date: string) => shortFormat.format(asDate(date));
/** "Oct 9" */
export const monthDayText = (date: string) => monthDayFormat.format(asDate(date));
/** "Friday, October 9, 2026" (screen readers) */
export const longDateText = (date: string) => longFormat.format(asDate(date));
/** Monday-first weekday headings for month grids. */
export const WEEKDAY_HEADINGS = weekOf('2024-01-01').map(weekdayText);
