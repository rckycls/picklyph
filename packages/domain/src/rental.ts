import { toUtcIso, validateRentalWindow, type Instant } from './booking.ts';
import { isPhpCentavos } from './money.ts';
import type { ScheduleInterval } from './schedule.ts';
import type { VenuePolicy } from './policy.ts';

export const RENTAL_PRICING = 'hourly_prorated_half_up_total_v1';
export type RentalPriceBand = ScheduleInterval & { duration_minutes: number };
export type RentalPrice = { currency: 'PHP'; pricing: typeof RENTAL_PRICING; duration_minutes: number; total_centavos: number; bands: RentalPriceBand[] };
export type RentalSnapshot = RentalPrice & {
  version: 1; allocation_id: string; venue_id: string; court_id: string; starts_at: string; ends_at: string; created_at: string;
  schedule_revision: string; court_hours_revision: string | null; policy_revision: string;
  policy: VenuePolicy & { merchant_active: boolean; player_refund_cutoff_hours: 24; approval_hold_minutes: 120; payment_hold_minutes: 15 };
};
export class RentalRuleError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = 'RentalRuleError'; this.reason = reason; }
}

/** Input feedback/parity helper. Commands must run SQL validation with the DB clock. */
export function requireRentalWindow(input: { startsAt: Instant; endsAt: Instant; now: Instant }): number {
  const result = validateRentalWindow(input);
  if (!result.ok) throw new RentalRuleError(result.reason);
  const start = Date.parse(toUtcIso(input.startsAt)); const end = Date.parse(toUtcIso(input.endsAt));
  if (result.durationMinutes > 1440) throw new RentalRuleError('maximum_duration');
  if (start % 1800000 || end % 1800000) throw new RentalRuleError('slot_alignment');
  if (start < Date.parse('2000-01-01T00:00:00+08:00') || end > Date.parse('2100-01-01T00:00:00+08:00')) throw new RentalRuleError('invalid_time');
  return result.durationMinutes;
}

/** Exact weighted centavo-minutes; round half up once, after complete contiguous coverage. */
export function priceRental(startsAt: Instant, endsAt: Instant, intervals: readonly ScheduleInterval[]): RentalPrice {
  const start = Date.parse(toUtcIso(startsAt)); const end = Date.parse(toUtcIso(endsAt));
  if (end <= start || end - start > 86400000 || start % 1800000 || end % 1800000) throw new RentalRuleError('invalid_time');
  let covered = start; let previousEnd = -Infinity; let numerator = 0n;
  const bands: RentalPriceBand[] = [];
  for (const interval of intervals) {
    const opens = Date.parse(toUtcIso(interval.starts_at)); const closes = Date.parse(toUtcIso(interval.ends_at));
    if (!isPhpCentavos(interval.hourly_centavos) || opens >= closes || opens % 1800000 || closes % 1800000 || opens < previousEnd) throw new RentalRuleError('invalid_rates');
    previousEnd = closes;
    const a = Math.max(start, opens); const b = Math.min(end, closes);
    if (a >= b) continue;
    if (a !== covered) throw new RentalRuleError('outside_hours');
    const minutes = (b - a) / 60000;
    numerator += BigInt(interval.hourly_centavos) * BigInt(minutes);
    bands.push({ starts_at: toUtcIso(a), ends_at: toUtcIso(b), hourly_centavos: interval.hourly_centavos, duration_minutes: minutes });
    covered = b;
  }
  if (covered !== end) throw new RentalRuleError('outside_hours');
  const total = (numerator + 30n) / 60n;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RentalRuleError('price_overflow');
  return { currency: 'PHP', pricing: RENTAL_PRICING, duration_minutes: (end - start) / 60000, total_centavos: Number(total), bands };
}
