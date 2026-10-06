# Shared money, time and rental rules (T09)

`@picklyph/domain` exports these pure helpers. Run `npm run test:domain` from
the root, or `npm test --workspace @picklyph/domain`. No credentials, Docker,
network access or new dependencies are needed.

## PHP amounts

Amounts are nonnegative safe integer **centavos** (100 centavos = 1 peso).
`isPhpCentavos` checks untrusted values and `assertPhpCentavos` throws on invalid
values. Fractions, numeric strings, negative amounts, nonfinite numbers and
unsafe integers are rejected. Zero is valid; a later product policy can require
a positive price.

`pesosToCentavos('1250.50')` returns `125050`. It accepts only a plain decimal
string with one or two optional fractional digits, and converts exactly using
integer arithmetic. Trim UI input before calling it; signs, separators, currency
symbols, scientific notation and excess decimal places are rejected. Never
calculate a stored amount by rounding a floating-point peso value.

`formatPhpCentavos(125050)` returns `₱1,250.50`. It groups whole pesos with an
explicit English Philippine locale and formats the centavo remainder separately
so even the maximum safe integer retains its exact cents. Display strings are
not payment-provider payloads. Rate calculations, provider amount limits,
price snapshots and payment/refund policy remain later tasks.

## Instants and Manila display

`toUtcIso` accepts a valid `Date`, integer Unix **milliseconds**, or an ISO
timestamp with seconds and explicit `Z`/`±HH:mm` offset. ISO fractions may have
up to three digits. It returns canonical UTC with milliseconds. It rejects
zone-less/date-only strings, calendar rollovers, leap seconds, nonfinite values,
fractional milliseconds and higher precision instead of silently changing them.
Future API adapters must explicitly normalize database microsecond timestamps
before passing them here. Do not pass Unix seconds as milliseconds.

`toManilaDateTime` returns `{ date: 'YYYY-MM-DD', time: 'HH:mm' }` for form/display
fields, dropping seconds and milliseconds. `formatManilaDateTime` returns a
readable English date/time. Both explicitly use `Asia/Manila`, independent of
the user's device/server timezone; localized punctuation/spacing may vary by
runtime. Label displayed times as Manila time in future screens. UTC storage
must keep the original instant, rather than round-trip through display fields.
[ECMAScript Intl DateTimeFormat](https://tc39.es/ecma402/#sec-intl.datetimeformat)

`fromManilaDateTime({ date: '2027-01-01', time: '00:00' })` returns
`2026-12-31T16:00:00.000Z`. It supports contemporary PH dates from 2000 onward,
strict dates and minute-resolution clocks. It constructs a `+08:00` instant
and verifies the result against the runtime's named-zone rules, throwing on a
mismatch. Historical PH daylight-saving dates are deliberately excluded from
this booking-input helper. If timezone rules change, update conversion before
accepting affected bookings.
[IANA Asia/Manila timezone data](https://data.iana.org/time-zones/tzdb/asia)

## Private rental boundaries

```ts
validateRentalWindow({
  now: '2026-12-31T15:59:00Z',
  startsAt: '2027-01-01T00:00:00+08:00',
  endsAt: '2027-01-01T01:30:00+08:00',
}); // { ok: true, durationMinutes: 90 }
```

The server must supply its authoritative `now`. A client result is only input
feedback; future booking commands must validate again during their transaction.

- Start must be strictly later than `now`; starting at exactly `now` fails.
- The start horizon is a rolling **60 × 24 hours**, inclusive at the exact upper
  instant. One millisecond later fails. It is not the end of the 60th Manila day.
  The rental end may cross that horizon, since this rule constrains the start.
- Duration must be at least **60 minutes** and an exact multiple of **30 minutes**.
  One millisecond short of the minimum fails; excess fractional increments fail.
  Reversed/zero intervals fail the minimum-duration rule.
- The result is `{ ok: true, durationMinutes }` or `{ ok: false, reason }`, with
  `invalid_time`, `start_not_future`, `outside_horizon`, `minimum_duration` or
  `duration_increment`. Checks run in that order for deterministic feedback.

Start-slot alignment, opening hours, overnight schedules, closures, owner
authorization, rate calculations and availability require later schedule and
transactional inventory checks. T09 does not implement bookings, holds,
cancellation/refunds or payments. The T06 provider/refund activation gates are
independent of the shared horizon default.
