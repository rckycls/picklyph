export const MANILA_TIME_ZONE = 'Asia/Manila';
export const RENTAL_INCREMENT_MINUTES = 30;
export const MINIMUM_RENTAL_MINUTES = 60;
export const BOOKING_HORIZON_DAYS = 60;

/** Explicit-offset ISO timestamp, valid Date, or integer Unix milliseconds. */
export type Instant = string | Date | number;
export type ManilaDateTime = { date: string; time: string };
export type RentalValidation =
  | { ok: true; durationMinutes: number }
  | { ok: false; reason: 'invalid_time' | 'start_not_future' | 'outside_horizon' | 'minimum_duration' | 'duration_increment' };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function instantMilliseconds(value: Instant): number {
  let milliseconds: number;
  if (typeof value === 'string') {
    if (!isoInstant.test(value)) throw new RangeError('Timestamp must include an explicit offset and at most three fractional digits.');
    // Date.parse can normalize impossible dates; validate the source wall-clock first.
    const wall = new Date(0);
    wall.setUTCFullYear(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
    wall.setUTCHours(Number(value.slice(11, 13)), Number(value.slice(14, 16)), Number(value.slice(17, 19)), 0);
    if (wall.toISOString().slice(0, 19) !== value.slice(0, 19)) throw new RangeError('Invalid calendar date or clock time.');
    milliseconds = Date.parse(value);
  } else {
    milliseconds = value instanceof Date ? value.getTime() : value;
  }
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) {
    throw new RangeError('Invalid instant.');
  }
  return milliseconds;
}

export function toUtcIso(value: Instant): string {
  return new Date(instantMilliseconds(value)).toISOString();
}

const manilaParts = new Intl.DateTimeFormat('en-US', {
  timeZone: MANILA_TIME_ZONE, calendar: 'iso8601', numberingSystem: 'latn',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Minute-resolution wall-clock fields for display/form inputs, never for UTC storage. */
export function toManilaDateTime(value: Instant): ManilaDateTime {
  const parts = manilaParts.formatToParts(instantMilliseconds(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => {
    const found = parts.find((item) => item.type === type);
    if (!found) throw new RangeError('Missing Manila date/time field.');
    return found.value;
  };
  return { date: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

/** Contemporary PH wall-clock input. Reject historical dates and timezone-rule mismatches. */
export function fromManilaDateTime({ date, time }: ManilaDateTime): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(date.slice(0, 4)) < 2000 || !/^\d{2}:\d{2}$/.test(time)) {
    throw new RangeError('Use a Manila date from 2000 onward and HH:mm clock time.');
  }
  const utc = toUtcIso(`${date}T${time}:00+08:00`);
  const actual = toManilaDateTime(utc);
  if (actual.date !== date || actual.time !== time) throw new RangeError('Manila wall-clock does not match timezone rules.');
  return utc;
}

const manilaDisplay = new Intl.DateTimeFormat('en-PH', {
  timeZone: MANILA_TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true,
});

export function formatManilaDateTime(value: Instant): string {
  return manilaDisplay.format(instantMilliseconds(value));
}

/** Pure rule check; callers supply an authoritative clock. Not an inventory/schedule check. */
export function validateRentalWindow(input: { startsAt: Instant; endsAt: Instant; now: Instant }): RentalValidation {
  let start: number;
  let end: number;
  let now: number;
  try {
    start = instantMilliseconds(input.startsAt);
    end = instantMilliseconds(input.endsAt);
    now = instantMilliseconds(input.now);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { ok: false, reason: 'invalid_time' };
  }
  if (start <= now) return { ok: false, reason: 'start_not_future' };
  // Rolling 60 * 24 hours, inclusive upper bound on start (not the rental end).
  if (start - now > BOOKING_HORIZON_DAYS * DAY_MS) return { ok: false, reason: 'outside_horizon' };
  const duration = end - start;
  if (duration < MINIMUM_RENTAL_MINUTES * MINUTE_MS) return { ok: false, reason: 'minimum_duration' };
  if (duration % (RENTAL_INCREMENT_MINUTES * MINUTE_MS) !== 0) return { ok: false, reason: 'duration_increment' };
  return { ok: true, durationMinutes: duration / MINUTE_MS };
}
