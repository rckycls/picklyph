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
not payment-provider payloads. T23 adds checked rental prices and immutable
snapshots below. Provider amount limits and payment/refund execution remain later tasks.

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

T23 adds start-slot alignment, opening/rate coverage and price/policy snapshots
below. T09 alone does not check inventory. The T06 provider/refund activation
gates are independent of the shared horizon default.

## Authoritative rental snapshots (T23)

Migration `20261008090000_rental_snapshots.sql` adds transaction-only helpers and
`private.rental_snapshots`, keyed by allocation ID. All API roles, including
`service_role`, have no table access or helper execution. RLS is enabled; a
trigger refuses snapshot updates. T24 now wraps these helpers with guarded
arrival booking commands; see [rental booking API](rental-bookings.md).

`private.rental_acquire(actor_user_id, court_id, starts, ends, hold_until, request)`
returns `{outcome, allocation, snapshot}`. It acquires a T21 rental allocation,
then calls `private.rental_snapshot_create(allocation_id)` in the same transaction.
Validation, pricing or later booking-command failure rolls both writes back.
The T24 command derives actor from verified Auth; the private primitive
only verifies that the player account exists. It is not an exposed Auth boundary.

New snapshots require an approved/verified venue with an owner link, active
court, configured schedule and live allocation. The DB clock is read after
venue→court→allocation locks (and a merchant read lock). T09's strict future
start, inclusive rolling 60×24-hour start horizon, one-hour minimum and exact
30-minute duration increments apply. T21 also requires half-hour boundary marks,
maximum 24 hours and Manila 2000–2099 limits. SQL `validate_rental_window` and
shared `requireRentalWindow` express the combined rules; the generic allocator
can reject malformed inventory boundaries first with `invalid_input`.

Prices use **current resolved court hours**, including narrowed court windows,
closures, special rates and overnight spill. SQL `rental_price` and shared
`priceRental` clip ordered rate intervals to the rental, reject gaps/overlaps or
invalid rates, and calculate exactly:

`total_centavos = floor((sum(hourly_centavos × duration_minutes) + 30) / 60)`

SQL uses exact numeric arithmetic; TypeScript uses BigInt. Round half up **once
on the total**, never per band: two half hours at 1 centavo/hour cost 1 centavo,
regardless of a rate or midnight split. Zero rates are allowed. Inputs and rounded
totals must fit nonnegative safe integer centavos; excess totals fail
`price_overflow` before commit. Bands store rates and minutes without rounded
subtotals. Pricing ID: `hourly_prorated_half_up_total_v1`.

`RentalSnapshot` includes version 1, allocation/venue/court IDs, UTC start/end and
DB creation time, currency/pricing ID, minutes, total, clipped bands and independent
schedule/court-hours/policy revision strings. Its effective policy contains
confirmation/payment and merchant-active state (inactive merchants force arrival),
plus the locked 24-hour player-refund cutoff, 120-minute approval hold maximum and
15-minute payment hold maximum. These constants do not execute refunds or choose
a booking's expiry.

Rate/policy edits serialize with creation through the venue lock. Waiting rentals
see committed edits. Existing snapshots remain unchanged; retries return the
original allocation and snapshot even after release/expiry, without reviving
inventory. Changed acquisition parameters fail `request_reused`. An old snapshot
does not promise that a booking is live or merchant still eligible for checkout.

**T24 contract (implemented):** call `rental_acquire` inside one authorized booking transaction
after the fail-closed `hold-create` Upstash guard. Apply effective policy and hold
choice under these same locks, persist lifecycle/audit rows, and return stored
snapshots on retries. Never trust client totals, policy or clocks. If offering a
client quote, compare its version/total under the locks and reject stale quotes
before commit. Generic `allocation_acquire` does not automatically create a
snapshot: rental commands must use this wrapper. T35 must also check current
merchant activation/payment eligibility. Snapshots cascade with allocation
deletion; T47 must establish retention before account/directory deletion ships.

**Verify:** `npm run test:domain`, `npm run test:rentals` and
`npm run test:rentals:local`. The local suite uses real Docker PostgreSQL sessions,
checks both lock orders for schedule/policy races, six concurrent retries and
surrounding-command rollback, and removes its own fixtures/accounts. Migration
applied locally only; hosted rollout remains separate.
