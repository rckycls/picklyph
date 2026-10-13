import {
  pesosToCentavos, readCourtHours, readVenueSchedule,
  type CourtHours, type CourtWindow, type OpeningWindow, type ScheduleException, type VenueSchedule,
} from '@picklyph/domain';

// Pure editing model for venue hours/rates, venue closures and court hours.
// Validation messages are owner-facing; the server validates everything again.
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
/** One priced stretch of a weekday in minutes from that day's Manila midnight; an end past 1440 runs after midnight. */
export type BandDraft = { start: number; end: number; pesos: string };
/** `special` keeps dated special hours (set by pickly) untouched; this editor adds and removes closures. */
export type ScheduleDraft = { weekly: BandDraft[][]; closures: string[]; special: ScheduleException[] };
export type CourtDraft = { custom: boolean; weekly: CourtWindow[][]; closures: string[] };

export class HoursDraftError extends Error {
  constructor(message: string) { super(message); this.name = 'HoursDraftError'; }
}

/** Closure choices: today and the following 365 Manila dates. */
export function closureDateOptions(today: string): string[] {
  return Array.from({ length: 366 }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
}

/** Exact decimal pesos for editing: 40000 → "400", 35050 → "350.50". */
export function pesosText(centavos: number): string {
  const pesos = Math.floor(centavos / 100); const rest = centavos % 100;
  return rest ? `${pesos}.${String(rest).padStart(2, '0')}` : String(pesos);
}

export function scheduleDraftFrom(schedule: VenueSchedule | null): ScheduleDraft {
  if (!schedule) return { weekly: Array.from({ length: 7 }, () => []), closures: [], special: [] };
  return {
    weekly: schedule.weekly.map((windows) => windows.flatMap((w) => w.rates.map((r) => ({ start: r.start_minute, end: r.end_minute, pesos: pesosText(r.hourly_centavos) })))),
    closures: schedule.exceptions.filter((e) => e.windows.length === 0).map((e) => e.date),
    special: schedule.exceptions.filter((e) => e.windows.length > 0),
  };
}

/** A new stretch after the last one (default 8 AM–10 PM on an empty day), keeping the last rate. */
export function addBand(bands: BandDraft[]): BandDraft[] {
  const last = bands[bands.length - 1];
  if (!last) return [{ start: 480, end: 1320, pesos: '' }];
  if (last.end >= 1440) return bands;
  return [...bands, { start: last.end, end: Math.min(last.end + 60, last.start + 1440), pesos: last.pesos }];
}
export function copyDayToAll(draft: ScheduleDraft, day: number): ScheduleDraft {
  return { ...draft, weekly: draft.weekly.map(() => draft.weekly[day]!.map((band) => ({ ...band }))) };
}
/** The Hours and Closures tabs save separately, through the same venue schedule command. */
export type ScheduleSection = 'hours' | 'closures';

/** What one tab's Save sends: its edits, with the other tab as last saved. Special hours travel with closures. */
export function scheduleSectionDraft(draft: ScheduleDraft, saved: ScheduleDraft, section: ScheduleSection): ScheduleDraft {
  return section === 'hours' ? { ...saved, weekly: draft.weekly } : { ...draft, weekly: saved.weekly };
}
/** Takes one tab back to `saved` (after its save, or to discard it) and keeps the other tab's unsaved edits. */
export function resetScheduleSection(draft: ScheduleDraft, saved: ScheduleDraft, section: ScheduleSection): ScheduleDraft {
  return scheduleSectionDraft(draft, saved, section === 'hours' ? 'closures' : 'hours');
}
export function scheduleSectionDirty(draft: ScheduleDraft, saved: ScheduleDraft, section: ScheduleSection): boolean {
  return JSON.stringify(scheduleSectionDraft(draft, saved, section)) !== JSON.stringify(saved);
}

/** Touching stretches (rate changes) read as one period: "8:00 AM – 10:00 PM, 11:00 PM – midnight". */
function periodsText(spans: { start: number; end: number }[], clock: (minute: number) => string): string {
  const periods: { start: number; end: number }[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = periods[periods.length - 1];
    if (last && span.start === last.end) last.end = span.end; else periods.push({ ...span });
  }
  return periods.map((p) => `${clock(p.start)} – ${clock(p.end)}`).join(', ');
}
/** A collapsed day row: "Closed", or its hours and rate ("8:00 AM – 10:00 PM · ₱400/hr"). */
export function daySummary(bands: BandDraft[], clock: (minute: number) => string): string {
  if (bands.length === 0) return 'Closed';
  const rates = [...new Set(bands.map((band) => band.pesos.trim()))];
  const rate = rates.includes('') ? 'rate missing' : rates.length === 1 ? `₱${rates[0]}/hr` : `${rates.length} rates`;
  return `${periodsText(bands, clock)} · ${rate}`;
}
/** A collapsed court day row: "Closed" or its periods. */
export function windowsSummary(windows: CourtWindow[], clock: (minute: number) => string): string {
  return windows.length ? periodsText(windows.map((w) => ({ start: w.start_minute, end: w.end_minute })), clock) : 'Closed';
}
/** A collapsed court row: whose hours it follows and how many closures are coming up. */
export function courtSummary(draft: CourtDraft, today: string): string {
  const closures = draft.closures.filter((date) => date >= today).length;
  return `${draft.custom ? 'Its own hours' : 'Same as venue hours'}${closures ? ` · ${closures} ${closures === 1 ? 'closure' : 'closures'}` : ''}`;
}

/** A closure replaces any special hours on that date. */
export function toggleClosure(draft: ScheduleDraft, date: string): ScheduleDraft {
  if (draft.closures.includes(date)) return { ...draft, closures: draft.closures.filter((d) => d !== date) };
  return { ...draft, closures: [...draft.closures, date].sort(), special: draft.special.filter((e) => e.date !== date) };
}

/** Groups touching stretches into opening windows with rate bands. Past closures are dropped. */
export function scheduleFromDraft(draft: ScheduleDraft, today: string): VenueSchedule {
  const weekly = draft.weekly.map((bands, day) => {
    const name = DAY_NAMES[day]!;
    const windows: OpeningWindow[] = [];
    for (const band of [...bands].sort((a, b) => a.start - b.start)) {
      if (band.end <= band.start) throw new HoursDraftError(`${name}: each closing time must be after its opening time.`);
      let cents: number;
      try { cents = pesosToCentavos(band.pesos.trim()); } catch { throw new HoursDraftError(`${name}: enter each hourly rate in pesos, like 400 or 350.50.`); }
      const last = windows[windows.length - 1];
      if (last && band.start < last.end_minute) throw new HoursDraftError(`${name}: two stretches overlap. Adjust their times.`);
      const rate = { start_minute: band.start, end_minute: band.end, hourly_centavos: cents };
      if (last && band.start === last.end_minute && last.rates.length < 16 && band.end - last.start_minute <= 1440) {
        last.end_minute = band.end; last.rates.push(rate);
      } else {
        // Only a new opening period must start that day; a touching stretch may continue past midnight.
        if (band.start >= 1440 || band.end - band.start > 1440) throw new HoursDraftError(`${name}: each opening period must start that day and last at most 24 hours.`);
        windows.push({ start_minute: band.start, end_minute: band.end, rates: [rate] });
      }
    }
    if (windows.length > 4) throw new HoursDraftError(`${name}: use at most 4 separate opening periods.`);
    return windows;
  });
  const exceptions = [...draft.closures.filter((date) => date >= today).map((date) => ({ date, windows: [] })), ...draft.special]
    .sort((a, b) => a.date.localeCompare(b.date));
  if (exceptions.length > 120) throw new HoursDraftError('Keep at most 120 closures and special dates. Remove some first.');
  try { return readVenueSchedule({ weekly, exceptions }); }
  catch { throw new HoursDraftError('Late-night hours overlap the next day’s opening. Adjust the overnight hours or the next morning.'); }
}

export function courtDraftFrom(hours: CourtHours): CourtDraft {
  return { custom: hours.weekly !== null,
    weekly: hours.weekly ? hours.weekly.map((day) => day.map((w) => ({ ...w }))) : Array.from({ length: 7 }, () => [{ start_minute: 480, end_minute: 1320 }]),
    closures: [...hours.closures] };
}
export function addCourtWindow(windows: CourtWindow[]): CourtWindow[] {
  const last = windows[windows.length - 1];
  if (!last) return [{ start_minute: 480, end_minute: 1320 }];
  if (last.end_minute >= 1410 || windows.length >= 4) return windows;
  return [...windows, { start_minute: last.end_minute + 30, end_minute: Math.min(last.end_minute + 90, 1440) }];
}
/** Court windows stay within one day; past closures are dropped. */
export function courtHoursFromDraft(draft: CourtDraft, today: string): CourtHours {
  const weekly = draft.weekly.map((windows, day) => {
    const name = DAY_NAMES[day]!;
    const sorted = [...windows].sort((a, b) => a.start_minute - b.start_minute);
    let previous = -1;
    for (const w of sorted) {
      if (w.end_minute <= w.start_minute) throw new HoursDraftError(`${name}: each closing time must be after its opening time.`);
      if (w.start_minute < previous) throw new HoursDraftError(`${name}: two periods overlap. Adjust their times.`);
      previous = w.end_minute;
    }
    if (sorted.length > 4) throw new HoursDraftError(`${name}: use at most 4 separate opening periods.`);
    return sorted;
  });
  const closures = draft.closures.filter((date) => date >= today);
  if (closures.length > 120) throw new HoursDraftError('Keep at most 120 closures. Remove some first.');
  try { return readCourtHours({ weekly: draft.custom ? weekly : null, closures }); }
  catch { throw new HoursDraftError('Check this court’s hours and closures.'); }
}
