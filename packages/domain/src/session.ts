import { readAllocationBlock, type CourtAllocation } from './allocation.ts';
import type { VenuePolicy } from './policy.ts';

export const MAX_SESSION_CAPACITY = 200;
export const DEFAULT_GROUP_LIMIT = 4;
export type SessionCreate = {
  venue_id: string; request_id: string; court_ids: string[]; title: string;
  starts_at: string; ends_at: string; capacity: number; group_limit: number; price_centavos: number;
};
export type SessionSnapshot = Omit<SessionCreate, 'venue_id' | 'request_id'> & {
  currency: 'PHP'; timezone: 'Asia/Manila'; policy: VenuePolicy & { merchant_active: boolean };
  policy_revision: string; schedule_revision: string | null; court_hours_revisions: { court_id: string; revision: string | null }[];
  approval_hold_minutes: 120; payment_hold_minutes: 15; refund_cutoff_hours: 24;
};
export type OpenPlaySession = {
  id: string; venue_id: string; status: 'scheduled' | 'cancelled'; created_at: string; cancelled_at: string | null;
  snapshot: SessionSnapshot; reserved_spots: number; allocations: CourtAllocation[];
};
export type SessionResult = { outcome: 'created' | 'existing' | 'cancelled'; session: OpenPlaySession };
export type SessionPage = { venue_id: string; at: string; sessions: OpenPlaySession[]; next_cursor: string | null };
export type SessionCommand = { kind: 'create'; command: SessionCreate } | { kind: 'cancel'; session_id: string };
export type SessionQuery = { venue_id: string; after_id: string | null };
export class SessionInputError extends Error { constructor() { super('Check the session details, courts and times.'); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(raw: unknown): string {
  if (typeof raw !== 'string' || !UUID.test(raw)) throw new SessionInputError();
  return raw.toLowerCase();
}
function object(raw: unknown, keys: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).sort().join(',') !== keys) throw new SessionInputError();
  return raw as Record<string, unknown>;
}
export function readSessionCreate(raw: unknown): SessionCreate {
  const r = object(raw, 'capacity,court_ids,ends_at,group_limit,price_centavos,request_id,starts_at,title,venue_id');
  if (!Array.isArray(r.court_ids) || r.court_ids.length < 1 || r.court_ids.length > 40) throw new SessionInputError();
  const courts = r.court_ids.map(uuid).sort();
  if (new Set(courts).size !== courts.length || typeof r.title !== 'string' || !r.title.trim()
    || [...r.title.trim()].length > 80 || /[\u0000-\u001f\u007f]/.test(r.title)) throw new SessionInputError();
  const capacity = r.capacity; const group = r.group_limit; const price = r.price_centavos;
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_SESSION_CAPACITY
    || typeof group !== 'number' || !Number.isInteger(group) || group < 1 || group > capacity
    || typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0
    || BigInt(price) * BigInt(capacity) > BigInt(Number.MAX_SAFE_INTEGER)) throw new SessionInputError();
  const window = readAllocationBlock({ court_id: courts[0], request_id: r.request_id, starts_at: r.starts_at, ends_at: r.ends_at });
  return { venue_id: uuid(r.venue_id), request_id: window.request_id, court_ids: courts, title: r.title.trim(),
    starts_at: window.starts_at, ends_at: window.ends_at, capacity, group_limit: group, price_centavos: price };
}
export function readSessionCommand(raw: unknown): SessionCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SessionInputError();
  const { kind, ...rest } = raw as Record<string, unknown>;
  if (kind === 'create') return { kind, command: readSessionCreate(rest) };
  if (kind === 'cancel') return { kind, session_id: uuid(object(rest, 'session_id').session_id) };
  throw new SessionInputError();
}
export function readSessionQuery(params: URLSearchParams): SessionQuery {
  if (![...params.keys()].sort().join(',').match(/^(after_id,)?venue_id$/)) throw new SessionInputError();
  return { venue_id: uuid(params.get('venue_id')), after_id: params.has('after_id') ? uuid(params.get('after_id')) : null };
}
