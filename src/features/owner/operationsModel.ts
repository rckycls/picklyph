import { ARRIVAL_PAYMENT_METHODS, formatManilaDateTime, formatPhpCentavos, toUtcIso,
  type ArrivalPaymentMethod, type BookingAttendance, type BookingOperations } from '@picklyph/domain';

const fail = (): never => { throw new Error('Unexpected booking record'); };
const instant = (v: unknown): string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
  ? toUtcIso(v.replace(/(\.\d{3})\d+/, '$1')) : fail();

/** T31 records: a payment always equals the booking's immutable total, and `payment_status` must agree with it. */
export function parseOperations(raw: unknown, paymentStatus: unknown, totalCentavos: number): BookingOperations {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const o = raw as Record<string, unknown>;
  if (!['none', 'checked_in', 'no_show', 'completed'].includes(o.attendance as string) || (o.attendance === 'none') !== (o.attendance_at === null)) return fail();
  let payment: BookingOperations['payment'] = null;
  if (o.payment !== null) {
    if (!o.payment || typeof o.payment !== 'object' || Array.isArray(o.payment)) return fail();
    const p = o.payment as Record<string, unknown>;
    if (!(ARRIVAL_PAYMENT_METHODS as readonly unknown[]).includes(p.method) || p.amount_centavos !== totalCentavos) return fail();
    payment = { method: p.method as ArrivalPaymentMethod, amount_centavos: totalCentavos, recorded_at: instant(p.recorded_at) };
  }
  if (paymentStatus !== (payment ? 'paid' : 'unpaid')) return fail();
  return { attendance: o.attendance as BookingAttendance, attendance_at: o.attendance === 'none' ? null : instant(o.attendance_at), payment };
}

export const PAYMENT_METHOD_LABELS: Record<ArrivalPaymentMethod, string> = {
  cash: 'Cash', ewallet: 'E-wallet', card: 'Card', bank_transfer: 'Bank transfer', other: 'Other',
};
const ATTENDANCE_LABELS: Record<BookingAttendance, string> = {
  none: 'Not checked in yet', checked_in: 'Checked in', no_show: 'Marked no-show', completed: 'Completed',
};
export function attendanceText(o: BookingOperations): string {
  return o.attendance_at ? `${ATTENDANCE_LABELS[o.attendance]} · ${formatManilaDateTime(o.attendance_at)}` : ATTENDANCE_LABELS[o.attendance];
}
export function paymentText(o: BookingOperations): string {
  return o.payment ? `Paid at the venue · ${formatPhpCentavos(o.payment.amount_centavos)} by ${PAYMENT_METHOD_LABELS[o.payment.method].toLowerCase()} · ${formatManilaDateTime(o.payment.recorded_at)}`
    : 'Unpaid · pay at the venue';
}
/** Guidance only: the server decides with its own clock and the booking's current state. */
export function availableOperations(o: BookingOperations, started: boolean): { checkIn: boolean; noShow: boolean; complete: boolean; pay: boolean } {
  if (!started) return { checkIn: false, noShow: false, complete: false, pay: false };
  return { checkIn: o.attendance === 'none', noShow: o.attendance === 'none' && !o.payment, complete: o.attendance === 'checked_in',
    pay: !o.payment && o.attendance !== 'no_show' };
}
