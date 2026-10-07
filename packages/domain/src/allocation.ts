import { toUtcIso, type Instant } from './booking.ts';

export const ALLOCATION_INCREMENT_MINUTES = 30;
export const MAX_ALLOCATION_MINUTES = 24 * 60;
/** Locked hold rule: approval holds last up to 2 hours, every hold capped at the start. */
export const MAX_HOLD_MINUTES = 120;
export const MAX_ALLOCATION_RANGE_DAYS = 31;

export type AllocationKind = 'block' | 'rental' | 'session';
export type AllocationState = 'active' | 'released' | 'expired';
/** Half-open [starts_at, ends_at) court inventory. expires_at null is firm; otherwise a hold. */
export type CourtAllocation = {
  id: string; venue_id: string; court_id: string; kind: AllocationKind;
  starts_at: string; ends_at: string; expires_at: string | null;
  state: AllocationState; ended_at: string | null;
};
export type AllocationOutcome = 'created' | 'existing' | 'released' | 'renewed';
export type AllocationResult = { outcome: AllocationOutcome; allocation: CourtAllocation };
export type AllocationRange = { venue_id: string; allocations: CourtAllocation[] };
/** Owner/admin block command. The actor always comes from verified Auth, never the body. */
export type AllocationBlock = { court_id: string; request_id: string; starts_at: string; ends_at: string };
export type AllocationRangeQuery = { venue_id: string; range_start: string; range_end: string };
export type AllocationRejection = 'invalid_input' | 'not_owner' | 'managed_allocation' | 'venue_unavailable' | 'court_unavailable'
  | 'allocation_not_found' | 'outside_hours' | 'allocation_conflict' | 'request_reused' | 'allocation_ended';

export class AllocationInputError extends Error {
  constructor() { super('Check the court and times.'); this.name = 'AllocationInputError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MINUTE_MS = 60_000;
function fields(raw: unknown, keys: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== keys) throw new AllocationInputError();
  return raw as Record<string, unknown>;
}
function uuid(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw new AllocationInputError();
  return raw.toLowerCase();
}
/** Explicit-offset ISO instant in 2000–2099 Manila time, normalized to UTC. */
function instant(raw: unknown): string {
  if (typeof raw !== 'string') throw new AllocationInputError();
  let value: string;
  try { value = toUtcIso(raw); } catch { throw new AllocationInputError(); }
  if (value < '1999-12-31T16:00:00.000Z' || value > '2099-12-31T16:00:00.000Z') throw new AllocationInputError();
  return value;
}
const ms = (value: Instant) => Date.parse(toUtcIso(value));

/** Mirrors SQL: 30-minute boundaries, positive length of at most 24 hours. */
export function readAllocationBlock(raw: unknown): AllocationBlock {
  const r = fields(raw, 'court_id,ends_at,request_id,starts_at');
  const starts_at = instant(r.starts_at); const ends_at = instant(r.ends_at);
  const start = Date.parse(starts_at); const end = Date.parse(ends_at); const step = ALLOCATION_INCREMENT_MINUTES * MINUTE_MS;
  if (start % step || end % step || end <= start || end - start > MAX_ALLOCATION_MINUTES * MINUTE_MS) throw new AllocationInputError();
  return { court_id: uuid(r.court_id), request_id: uuid(r.request_id), starts_at, ends_at };
}
export function readAllocationRangeQuery(raw: unknown): AllocationRangeQuery {
  const r = fields(raw, 'range_end,range_start,venue_id');
  const range_start = instant(r.range_start); const range_end = instant(r.range_end);
  const length = Date.parse(range_end) - Date.parse(range_start);
  if (length <= 0 || length > MAX_ALLOCATION_RANGE_DAYS * 24 * 60 * MINUTE_MS) throw new AllocationInputError();
  return { venue_id: uuid(r.venue_id), range_start, range_end };
}

/** Half-open: touching endpoints do not overlap. */
export function allocationsOverlap(a: { starts_at: Instant; ends_at: Instant }, b: { starts_at: Instant; ends_at: Instant }): boolean {
  return ms(a.starts_at) < ms(b.ends_at) && ms(b.starts_at) < ms(a.ends_at);
}
/** Same rule as SQL `private.allocation_live`: an elapsed hold is free even before any write marks it. */
export function isLiveAllocation(a: Pick<CourtAllocation, 'state' | 'expires_at'>, at: Instant): boolean {
  return a.state === 'active' && (a.expires_at === null || ms(a.expires_at) > ms(at));
}
/** Hold expiry for later booking commands: `minutes` from the server clock, capped at the start. */
export function holdUntil(at: Instant, startsAt: Instant, minutes: number): string {
  const now = ms(at); const start = ms(startsAt);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_HOLD_MINUTES || start <= now) throw new AllocationInputError();
  return new Date(Math.min(now + minutes * MINUTE_MS, start)).toISOString();
}
