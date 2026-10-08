import { MAX_SESSION_CAPACITY, type SessionSnapshot } from './session.ts';
import type { VenuePolicy } from './policy.ts';

export const MAX_PARTICIPANT_NAME = 60;
/** Streamed body bound for group requests; a full 200-name group of short names fits. */
export const MAX_SESSION_BOOKING_BYTES = 16384;
export type SessionOffer = {
  id: string; venue_id: string; status: 'scheduled' | 'cancelled';
  snapshot: Omit<SessionSnapshot, 'schedule_revision' | 'court_hours_revisions' | 'policy_revision'>; available_spots: number;
};
export type SessionOfferPage = { venue_id: string; at: string; sessions: SessionOffer[]; next_cursor: string | null };
export type SessionBookingSnapshot = {
  venue_id: string; title: string; court_ids: string[]; starts_at: string; ends_at: string;
  price_centavos: number; spots: number; total_centavos: number; currency: 'PHP'; timezone: 'Asia/Manila';
  policy: VenuePolicy & { merchant_active: boolean }; policy_revision: string;
  approval_hold_minutes: 120; payment_hold_minutes: 15; refund_cutoff_hours: 24;
};
export type SessionBooking = {
  id: string; session_id: string; status: 'pending' | 'confirmed' | 'declined' | 'cancelled' | 'expired';
  payment_method: 'arrival'; payment_status: 'unpaid'; participants: string[]; spots: number;
  expires_at: string | null; created_at: string; updated_at: string; snapshot: SessionBookingSnapshot;
};
export type SessionBookingResult = { outcome: 'created' | 'existing' | 'changed' | 'expired'; booking: SessionBooking };
export type SessionBookingPage = { bookings: SessionBooking[]; next_cursor: string | null };
export type SessionBookingRequest = { kind: 'request'; session_id: string; request_id: string; participants: string[]; expected_total_centavos: number };
export type SessionBookingChange = { kind: 'accept' | 'decline' | 'cancel'; booking_id: string };
export type SessionBookingCommand = SessionBookingRequest | SessionBookingChange;
export type SessionBookingQuery = { section: 'sessions'; venue_id: string; after_id: string | null }
  | { section: 'session'; session_id: string }
  | { section: 'booking'; booking_id: string }
  | { section: 'history'; after_id: string | null }
  | { section: 'requests'; venue_id: string; after_id: string | null };

export class SessionBookingInputError extends Error {
  constructor() { super('Check the group names and session.'); this.name = 'SessionBookingInputError'; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new SessionBookingInputError();
  return value.toLowerCase();
}
function fields(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys) throw new SessionBookingInputError();
  return value as Record<string, unknown>;
}
/** Trimmed names, 1–60 characters, no control characters, unique ignoring case. Order is preserved. */
export function readParticipantNames(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SESSION_CAPACITY) throw new SessionBookingInputError();
  const names = raw.map((name) => {
    if (typeof name !== 'string') throw new SessionBookingInputError();
    const trimmed = name.trim();
    if (!trimmed || [...trimmed].length > MAX_PARTICIPANT_NAME || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new SessionBookingInputError();
    return trimmed;
  });
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new SessionBookingInputError();
  return names;
}
/** Exact group total from the immutable per-person session price; T27 bounds price × capacity. */
export function sessionGroupTotal(priceCentavos: number, spots: number): number {
  const total = priceCentavos * spots;
  if (!Number.isSafeInteger(priceCentavos) || priceCentavos < 0 || !Number.isInteger(spots) || spots < 1 || !Number.isSafeInteger(total))
    throw new SessionBookingInputError();
  return total;
}
export function readSessionBookingCommand(raw: unknown): SessionBookingCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SessionBookingInputError();
  const kind = (raw as Record<string, unknown>).kind;
  if (kind === 'request') {
    const r = fields(raw, 'expected_total_centavos,kind,participants,request_id,session_id');
    if (typeof r.expected_total_centavos !== 'number' || !Number.isSafeInteger(r.expected_total_centavos) || r.expected_total_centavos < 0)
      throw new SessionBookingInputError();
    return { kind, session_id: uuid(r.session_id), request_id: uuid(r.request_id), participants: readParticipantNames(r.participants),
      expected_total_centavos: r.expected_total_centavos };
  }
  if (kind !== 'accept' && kind !== 'decline' && kind !== 'cancel') throw new SessionBookingInputError();
  return { kind, booking_id: uuid(fields(raw, 'booking_id,kind').booking_id) };
}
export function readSessionBookingQuery(params: URLSearchParams): SessionBookingQuery {
  const r: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key in r) throw new SessionBookingInputError();
    r[key] = value;
  }
  const after = (keys: string) => {
    fields(r, r.after_id === undefined ? keys : 'after_id,' + keys);
    return r.after_id === undefined ? null : uuid(r.after_id);
  };
  const section = r.section;
  if (section === 'sessions' || section === 'requests') {
    const after_id = after('section,venue_id');
    return { section, venue_id: uuid(r.venue_id), after_id };
  }
  if (r.section === 'history') return { section: 'history', after_id: after('section') };
  if (r.section === 'session') return { section: 'session', session_id: uuid(fields(r, 'section,session_id').session_id) };
  if (r.section === 'booking') return { section: 'booking', booking_id: uuid(fields(r, 'booking_id,section').booking_id) };
  throw new SessionBookingInputError();
}
