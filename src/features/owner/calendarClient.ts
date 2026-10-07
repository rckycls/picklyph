import {
  readCourtHours, readVenueSchedule,
  type AllocationBlock, type AllocationKind, type AllocationOutcome, type AllocationResult, type AllocationState,
  type CalendarCourt, type CalendarView, type CourtAllocation, type CourtHoursSave, type CourtHoursView,
  type ScheduleInterval, type ScheduleSave, type ScheduleView,
} from '@picklyph/domain';

import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from './venueClient';

// Pure client for the owner-schedules Edge function: calendar, blocks and hours.
export type CalendarRejection =
  | 'invalid_request' | 'invalid_input' | 'not_owner' | 'venue_unavailable' | 'court_unavailable' | 'allocation_not_found'
  | 'managed_allocation' | 'outside_hours' | 'allocation_conflict' | 'request_reused' | 'allocation_ended'
  | 'version_conflict' | 'hours_conflict';
export type CalendarFailure = HttpFailure<CalendarRejection>;
export type CalendarOutcome<T> = HttpOutcome<T, CalendarRejection>;

const REJECTIONS: readonly CalendarRejection[] = ['invalid_request', 'invalid_input', 'not_owner', 'venue_unavailable', 'court_unavailable',
  'allocation_not_found', 'managed_allocation', 'outside_hours', 'allocation_conflict', 'request_reused', 'allocation_ended',
  'version_conflict', 'hours_conflict'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly AllocationKind[] = ['block', 'rental', 'session'];
const STATES: readonly AllocationState[] = ['active', 'released', 'expired'];
const OUTCOMES: readonly AllocationOutcome[] = ['created', 'existing', 'released', 'renewed'];
const unexpected = (): never => { throw new Error('Unexpected calendar response.'); };
const record = (value: unknown): Record<string, unknown> =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : unexpected());
const id = (value: unknown): string => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : unexpected());
// Server timestamps carry explicit offsets; compare instants, never spellings.
const instant = (value: unknown): string => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : unexpected());
const revision = (value: unknown): string | null => (value === null || (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) ? value : unexpected());
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) && value.length <= max ? value : unexpected());

function parseInterval(raw: unknown): ScheduleInterval {
  const i = record(raw);
  const cents = i.hourly_centavos;
  if (!Number.isSafeInteger(cents) || (cents as number) < 0) return unexpected();
  return { starts_at: instant(i.starts_at), ends_at: instant(i.ends_at), hourly_centavos: cents as number };
}
export function parseAllocation(raw: unknown): CourtAllocation {
  const a = record(raw);
  if (!KINDS.includes(a.kind as AllocationKind) || !STATES.includes(a.state as AllocationState)) return unexpected();
  return { id: id(a.id), venue_id: id(a.venue_id), court_id: id(a.court_id), kind: a.kind as AllocationKind,
    starts_at: instant(a.starts_at), ends_at: instant(a.ends_at), expires_at: a.expires_at === null ? null : instant(a.expires_at),
    state: a.state as AllocationState, ended_at: a.ended_at === null ? null : instant(a.ended_at) };
}
export function parseCourtHoursView(raw: unknown): CourtHoursView {
  const v = record(raw);
  return { court_id: id(v.court_id), revision: revision(v.revision), hours: readCourtHours(v.hours) };
}
export function parseCalendar(raw: unknown, venueId: string): CalendarView {
  const c = record(raw);
  if (id(c.venue_id) !== venueId.toLowerCase() || typeof c.name !== 'string' || typeof c.start_date !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(c.start_date) || !Number.isInteger(c.days) || (c.days as number) < 1 || (c.days as number) > 7) return unexpected();
  const courts = list(c.courts, 40).map((value): CalendarCourt => {
    const court = record(value);
    if (typeof court.name !== 'string' || (court.status !== 'active' && court.status !== 'inactive')) return unexpected();
    return { ...parseCourtHoursView(court), name: court.name, status: court.status, intervals: list(court.intervals, 2000).map(parseInterval) };
  });
  const allocations = list(c.allocations, 5000).map(parseAllocation);
  return { venue_id: venueId.toLowerCase(), name: c.name, start_date: c.start_date, days: c.days as number, at: instant(c.at),
    schedule_revision: revision(c.schedule_revision), courts, allocations };
}
export function parseScheduleView(raw: unknown, venueId: string): ScheduleView {
  const v = record(raw);
  if (id(v.venue_id) !== venueId.toLowerCase()) return unexpected();
  return { venue_id: venueId.toLowerCase(), revision: revision(v.revision), schedule: v.schedule === null ? null : readVenueSchedule(v.schedule),
    intervals: list(v.intervals, 2000).map(parseInterval) };
}
function parseResult(raw: Record<string, unknown>): AllocationResult {
  if (!OUTCOMES.includes(raw.outcome as AllocationOutcome)) return unexpected();
  return { outcome: raw.outcome as AllocationOutcome, allocation: parseAllocation(raw.allocation) };
}

const post = (body: unknown, signal?: AbortSignal): RequestInit =>
  ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
const query = (transport: OwnerHttpTransport, params: Record<string, string>) => `${transport.endpoint}?${new URLSearchParams(params).toString()}`;

export function loadCalendar(transport: OwnerHttpTransport, venueId: string, startDate: string, days: number, signal?: AbortSignal): Promise<CalendarOutcome<CalendarView>> {
  return ownerRequest(transport, query(transport, { venue_id: venueId, start_date: startDate, days: String(days), section: 'calendar' }),
    { method: 'GET', signal }, (body) => parseCalendar(body, venueId), REJECTIONS);
}
/** Venue-wide rules; the one resolved day keeps the reply small. */
export function loadVenueSchedule(transport: OwnerHttpTransport, venueId: string, startDate: string, signal?: AbortSignal): Promise<CalendarOutcome<ScheduleView>> {
  return ownerRequest(transport, query(transport, { venue_id: venueId, start_date: startDate, days: '1' }), { method: 'GET', signal },
    (body) => parseScheduleView(body, venueId), REJECTIONS);
}
/** A stale revision returns `version_conflict`; hours that would move a block or booking return `hours_conflict`. */
export function saveVenueSchedule(transport: OwnerHttpTransport, command: ScheduleSave, signal?: AbortSignal): Promise<CalendarOutcome<ScheduleView>> {
  return ownerRequest(transport, transport.endpoint, post(command, signal), (body) => parseScheduleView(body, command.venue_id), REJECTIONS);
}
export function saveCourtHours(transport: OwnerHttpTransport, command: CourtHoursSave, signal?: AbortSignal): Promise<CalendarOutcome<CourtHoursView>> {
  return ownerRequest(transport, transport.endpoint, post({ kind: 'save_court_hours', ...command }, signal), (body) => {
    const view = parseCourtHoursView(body);
    return view.court_id === command.court_id.toLowerCase() ? view : unexpected();
  }, REJECTIONS);
}
/** After a network failure, retry with the same request_id: the server returns the original block. */
export function blockCourt(transport: OwnerHttpTransport, command: AllocationBlock): Promise<CalendarOutcome<AllocationResult>> {
  return ownerRequest(transport, transport.endpoint, post({ kind: 'block', ...command }), parseResult, REJECTIONS);
}
/** Idempotent: releasing again returns the released block. */
export function releaseBlock(transport: OwnerHttpTransport, allocationId: string): Promise<CalendarOutcome<AllocationResult>> {
  return ownerRequest(transport, transport.endpoint, post({ kind: 'release_block', allocation_id: allocationId }), parseResult, REJECTIONS);
}

export function calendarFailureMessage(failure: CalendarFailure): string {
  switch (failure.kind) {
    case 'sign_in': return 'Your sign-in has expired. Sign in again from Account, then retry.';
    case 'network': return 'Couldn’t reach pickly. Check your connection, then try again.';
    case 'rate_limited': return `Too many changes right now. Try again in ${failure.retryAfterSeconds} seconds.`;
    case 'not_configured': return 'Court calendars aren’t set up in this build.';
    case 'unavailable': return 'Couldn’t confirm this change. Reload the calendar to check before trying again.';
    case 'rejected':
      switch (failure.reason) {
        case 'not_owner': return 'You no longer manage this venue. Contact pickly support if this is a mistake.';
        case 'venue_unavailable': return 'This venue can’t be managed right now because it isn’t published. Contact pickly support.';
        case 'court_unavailable': return 'That court isn’t active. Make it active from Edit venue first.';
        case 'outside_hours': return 'That time is outside this court’s opening hours. Check its hours and closures.';
        case 'allocation_conflict': return 'Someone else already has part of that time. Reload the calendar and choose a free time.';
        case 'hours_conflict': return 'These hours would leave a block or booking outside opening hours. Release the block first, or keep those hours open.';
        case 'version_conflict': return 'These hours changed since you opened them. Reload to see the latest, then make your changes again.';
        case 'managed_allocation': return 'Bookings are changed from the booking itself, not the calendar.';
        case 'allocation_not_found': return 'That block no longer exists. Reload the calendar.';
        case 'allocation_ended':
        case 'request_reused':
        case 'invalid_input':
        case 'invalid_request': return 'Something in this change couldn’t be accepted. Check the times and try again.';
      }
  }
  // Never render a blank failure, even for an unexpected value at runtime.
  return 'Something went wrong. Nothing was changed; try again shortly.';
}
