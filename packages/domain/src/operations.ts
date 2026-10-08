import { isPhpCentavos } from './money.ts';

/** Front-desk records (T31): attendance and recorded arrival payments sit beside a booking and never change its status or snapshot. */
export const ARRIVAL_PAYMENT_METHODS = ['cash', 'ewallet', 'card', 'bank_transfer', 'other'] as const;
export type ArrivalPaymentMethod = typeof ARRIVAL_PAYMENT_METHODS[number];
export type BookingAttendance = 'none' | 'checked_in' | 'no_show' | 'completed';
export type ArrivalPayment = { method: ArrivalPaymentMethod; amount_centavos: number; recorded_at: string };
export type BookingOperations = { attendance: BookingAttendance; attendance_at: string | null; payment: ArrivalPayment | null };
export type AttendanceCommand = { kind: 'check_in' | 'no_show' | 'complete'; booking_id: string };
/** The amount must equal the booking's immutable total; it confirms what the owner collected, never sets a price. */
export type PaymentRecord = { kind: 'record_payment'; booking_id: string; method: ArrivalPaymentMethod; amount_centavos: number };
export type BookingOperationCommand = AttendanceCommand | PaymentRecord;
/** Owner front desk: one Manila date of confirmed bookings at a venue, ascending UUID pages of 25. */
export type OperationsDayQuery = { section: 'day'; venue_id: string; date: string; after_id: string | null };
export const MAX_GUEST_NAME = 60;
export const OPERATION_KINDS = ['check_in', 'no_show', 'complete', 'record_payment'] as const;

export class OperationInputError extends Error {
  constructor() { super('Check the booking record.'); this.name = 'OperationInputError'; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new OperationInputError();
  return value.toLowerCase();
}
function fields(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys) throw new OperationInputError();
  return value as Record<string, unknown>;
}
export function isOperationKind(kind: unknown): kind is BookingOperationCommand['kind'] {
  return (OPERATION_KINDS as readonly unknown[]).includes(kind);
}
/** Owner label for an outside rental: trimmed, 1–60 characters, no control characters. */
export function readGuestName(raw: unknown): string {
  if (typeof raw !== 'string') throw new OperationInputError();
  const name = raw.trim();
  if (!name || [...name].length > MAX_GUEST_NAME || /[\u0000-\u001f\u007f]/.test(name)) throw new OperationInputError();
  return name;
}
export function readBookingOperation(raw: unknown): BookingOperationCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OperationInputError();
  const kind = (raw as Record<string, unknown>).kind;
  if (kind === 'record_payment') {
    const r = fields(raw, 'amount_centavos,booking_id,kind,method');
    if (!(ARRIVAL_PAYMENT_METHODS as readonly unknown[]).includes(r.method) || !isPhpCentavos(r.amount_centavos)) throw new OperationInputError();
    return { kind, booking_id: uuid(r.booking_id), method: r.method as ArrivalPaymentMethod, amount_centavos: r.amount_centavos as number };
  }
  if (kind !== 'check_in' && kind !== 'no_show' && kind !== 'complete') throw new OperationInputError();
  return { kind, booking_id: uuid(fields(raw, 'booking_id,kind').booking_id) };
}
/** A real calendar date within the supported 2000–2099 Manila range. */
export function readOperationsDate(raw: unknown): string {
  if (typeof raw !== 'string' || !/^(20\d{2})-(\d{2})-(\d{2})$/.test(raw)) throw new OperationInputError();
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw new OperationInputError();
  return raw;
}
export function readOperationsDayQuery(r: Record<string, string>): OperationsDayQuery {
  fields(r, r.after_id === undefined ? 'date,section,venue_id' : 'after_id,date,section,venue_id');
  return { section: 'day', venue_id: uuid(r.venue_id), date: readOperationsDate(r.date), after_id: r.after_id === undefined ? null : uuid(r.after_id) };
}
