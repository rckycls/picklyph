import { readAllocationBlock } from './allocation.ts';
import type { CourtAllocation } from './allocation.ts';
import type { RentalPrice, RentalSnapshot } from './rental.ts';
import type { VenuePolicy } from './policy.ts';
import { isPhpCentavos } from './money.ts';

export type RentalQuoteVersion = { total_centavos: number; schedule_revision: string; court_hours_revision: string | null; policy_revision: string };
export type RentalQuote = RentalPrice & { court_id: string; venue_id: string; starts_at: string; ends_at: string; quoted_at: string;
  policy: VenuePolicy & { merchant_active: boolean }; expected_quote: RentalQuoteVersion };
export type RentalBooking = { id: string; status: 'pending' | 'confirmed' | 'declined' | 'cancelled' | 'expired';
  payment_method: 'arrival'; payment_status: 'unpaid'; created_at: string; updated_at: string; allocation: CourtAllocation; snapshot: RentalSnapshot };
export type RentalBookingResult = { outcome: 'created' | 'existing' | 'changed' | 'expired'; booking: RentalBooking };
export type RentalBookingPage = { bookings: RentalBooking[]; next_cursor: string | null };
export type RentalRequest = { kind: 'request'; court_id: string; request_id: string; starts_at: string; ends_at: string; expected_quote: RentalQuoteVersion };
export type RentalChange = { kind: 'accept' | 'decline' | 'cancel' | 'expire'; booking_id: string };
export type RentalCommand = RentalRequest | RentalChange;
export type RentalQuery = { section: 'quote'; court_id: string; starts_at: string; ends_at: string }
  | { section: 'booking'; booking_id: string }
  | { section: 'history'; after_id: string | null }
  | { section: 'requests'; venue_id: string; after_id: string | null };

export class RentalInputError extends Error {
  constructor() { super('Check the rental request.'); this.name = 'RentalInputError'; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new RentalInputError();
  return value.toLowerCase();
}
function fields(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys) throw new RentalInputError();
  return value as Record<string, unknown>;
}
function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new RentalInputError();
  return value;
}
function window(court: unknown, starts: unknown, ends: unknown) {
  try {
    const block = readAllocationBlock({ court_id: court, starts_at: starts, ends_at: ends, request_id: '00000000-0000-0000-0000-000000000000' });
    if (Date.parse(block.ends_at) - Date.parse(block.starts_at) < 3600000) throw new RentalInputError();
    return { court_id: block.court_id, starts_at: block.starts_at, ends_at: block.ends_at };
  } catch { throw new RentalInputError(); }
}
export function readRentalCommand(raw: unknown): RentalCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RentalInputError();
  const kind = (raw as Record<string, unknown>).kind;
  if (kind === 'request') {
    const r = fields(raw, 'court_id,ends_at,expected_quote,kind,request_id,starts_at');
    const q = fields(r.expected_quote, 'court_hours_revision,policy_revision,schedule_revision,total_centavos');
    if (!isPhpCentavos(q.total_centavos)) throw new RentalInputError();
    return { kind, ...window(r.court_id, r.starts_at, r.ends_at), request_id: uuid(r.request_id), expected_quote: {
      total_centavos: q.total_centavos, schedule_revision: revision(q.schedule_revision), policy_revision: revision(q.policy_revision),
      court_hours_revision: q.court_hours_revision === null ? null : revision(q.court_hours_revision),
    } };
  }
  if (!['accept', 'decline', 'cancel', 'expire'].includes(String(kind))) throw new RentalInputError();
  const r = fields(raw, 'booking_id,kind');
  return { kind: kind as RentalChange['kind'], booking_id: uuid(r.booking_id) };
}
export function readRentalQuery(params: URLSearchParams): RentalQuery {
  const r: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in r) throw new RentalInputError();
    r[key] = value;
  }
  if (r.section === 'quote') {
    fields(r, 'court_id,ends_at,section,starts_at');
    return { section: 'quote', ...window(r.court_id, r.starts_at, r.ends_at) };
  }
  if (r.section === 'booking') {
    fields(r, 'booking_id,section');
    return { section: 'booking', booking_id: uuid(r.booking_id) };
  }
  if (r.section === 'history' || r.section === 'requests') {
    const keys = r.section === 'history' ? 'section' : 'section,venue_id';
    fields(r, r.after_id === undefined ? keys : 'after_id,' + keys);
    const after_id = r.after_id === undefined ? null : uuid(r.after_id);
    return r.section === 'history' ? { section: 'history', after_id } : { section: 'requests', venue_id: uuid(r.venue_id), after_id };
  }
  throw new RentalInputError();
}
