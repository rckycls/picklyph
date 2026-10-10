# Owner front desk (T31)

Current owners work one request queue, record outside rentals in the shared court inventory, check guests in, mark no-shows and completions, and record arrival payments. Attendance and payments are **records beside a booking**: they never change its status, snapshot, hold or inventory. pickly collects no money here. The pilot is pay-on-arrival only (user decision 2026-10-10); online checkout T34–T36 and automated refunds T40 are deferred. Owner cancellation of confirmed unpaid arrival bookings and occupied sessions remains a pilot task, T40a, independent of PayMongo.

Everything below runs through the existing `rental-bookings` and `session-bookings` Edge functions, with the same verified bearer, isolated service client, `private, no-store` replies and strict parsing as T24/T28. Admin or moderator roles alone grant no access. A current owner is a verified, still-linked owner of the booking's venue.

## Request queue

`GET ?section=requests&venue_id=UUID[&after_id=UUID]` on each function lists live pending rentals or player groups (T24/T28), and `POST {kind:"accept"|"decline",booking_id}` decides them. The app shows both in one queue at `/owner/requests/[id]`. An elapsed hold returns `expired` and is never revived.

## Outside rentals

```json
{
  "kind": "owner_entry",
  "court_id": "<uuid>",
  "request_id": "<new UUID retained across retries>",
  "starts_at": "2026-10-09T08:00:00+08:00",
  "ends_at": "2026-10-09T09:00:00+08:00",
  "guest_name": "Walk-up guest",
  "expected_quote": { "total_centavos": 40000, "schedule_revision": "1", "court_hours_revision": null, "policy_revision": "0" }
}
```

A current owner records a booking taken by phone, chat or at the counter. It is a rental (`source: "owner"`) with an immutable T23 snapshot, created by `private.rental_acquire` under the same **venue → court** locks as player rentals, blocks and sessions. Any overlap returns `allocation_conflict`. It follows the player rental rules: a reviewed `section=quote` token (`stale_quote` on change), a future start on a 30-minute mark, 60–1440 minutes, the 60-day horizon, court hours, an approved venue and arrival payment (`arrival_unavailable` for online-only). It is **confirmed and firm on entry**, whatever the venue's confirmation policy. `guest_name` is a trimmed label of 1–60 characters that only owners read.

The entry shares the `(actor, request_id)` retry key space with player rentals: repeating it returns `existing`, and the same key with other details, or on the other path, returns `request_reused`. Retries and reads need current ownership. Player history never lists entries, and the creator cannot read them as a player. Any current owner (not only the creator) cancels an entry before it starts with `{kind:"cancel"}`. Entries record an `owner_entry` event.

## Attendance and arrival payments

On either function, for that function's bookings:

```json
{ "kind": "check_in", "booking_id": "<uuid>" }
{ "kind": "record_payment", "booking_id": "<uuid>", "method": "cash", "amount_centavos": 40000 }
```

| Command | Allowed when | Effect |
| --- | --- | --- |
| `check_in` | attendance `none` | `checked_in` |
| `no_show` | attendance `none`, no payment recorded | `no_show` (final) |
| `complete` | attendance `checked_in` | `completed` (final) |
| `record_payment` | no payment yet, not a no-show; `amount_centavos` equals the snapshot total | one arrival payment record |

All four need a **confirmed** booking (rentals of either source, player groups and walk-ins) in a scheduled session, and the server clock at or after the booking's start (`not_started` otherwise). Player cancellation closes at the start, so a check-in or payment can never meet a later player cancellation. Methods are `cash`, `ewallet`, `card`, `bank_transfer` and `other`. Payments are full-amount only, so a mismatched amount returns `amount_mismatch`.

Repeating a command returns `existing` with no new event. `check_in` after `completed` is also `existing`. A different payment after one is recorded returns `payment_recorded`. Out-of-order steps return `invalid_transition`. There is no undo: records are append-only, and corrections belong to a later admin task.

## Front-desk reads and booking records

`GET ?section=day&venue_id=UUID&date=YYYY-MM-DD[&after_id=UUID]` returns `{venue_id,date,at,bookings,next_cursor}`: confirmed rentals (on `rental-bookings`) or confirmed groups in scheduled sessions (on `session-bookings`) starting on that Manila date, in ascending UUID pages of 25. `at` is the database read time. Dates run from 2000 to 2099.

Every rental and group record now includes `operations: {attendance, attendance_at, payment}` (`payment` is `{method, amount_centavos, recorded_at}` or null). `payment_status` reads `paid` exactly when a payment is recorded. Rentals add `source` (`player` or `owner`) and `guest_name` (null for players). Players see their own attendance and payment. Records carry no account IDs.

## Guards, storage and locks

| Command | Upstash bucket | Redis outage |
| --- | --- | --- |
| `owner_entry` | `owner-edit` | 503, no write (creates inventory) |
| `check_in`, `no_show`, `complete`, `record_payment` | `owner-ops` (60/min) | continues (no inventory or charge) |
| `section=day` | `owner-read` | continues |

Migration `20261009060000_booking_operations.sql` adds `rental_bookings.source`/`guest_name` (immutable, guarded) and private `booking_operations`: one row per rental or group, RLS on, no API-role grants, and a guard trigger that allows only the transitions above and never changes a recorded payment. Records lock **venue (share) → owner link (share) → booking row (update)**. This never takes a court or session lock after the booking row, so it cannot deadlock with T24/T28 lifecycle commands. Each record and its `check_in|no_show|complete|payment` event in `rental_events` or `session_booking_events` commit together, so a failed event rolls the record back. Service-only RPCs: `rental_booking_owner_entry`, `booking_operation(actor,kind,booking,command,method,amount)` and `booking_operations_read(actor,kind,venue,target_day,after)`. `rental_booking_request|change|read` were redefined for sources.

| Reason | HTTP |
| --- | --- |
| `not_owner` | 403 |
| `booking_not_found`, `venue_unavailable`, `court_unavailable` | 404 |
| `not_started`, `payment_recorded`, `amount_mismatch`, `invalid_transition`, `allocation_conflict`, `stale_quote`, `request_reused`, `arrival_unavailable` | 409 |

## App

Your venues shows **Booking requests** and **Front desk** for published, verified venues.

- **Booking requests** (`/owner/requests/[id]`) lists pending rentals and groups, with hold ends and short references. Accept, or decline after a confirmation prompt.
- **Front desk** (`/owner/desk/[id]?date=`) steps through Manila dates and lists that day's confirmed rentals and groups. Each card shows the court or session, guest or names, short reference, attendance and payment. Check-in, completion, no-show (confirmed first) and payment (method, then a confirmation) appear once the server's read time passes the start.
- **Outside booking** (`/owner/entry/[id]`) quotes a court and time, takes a guest label and records the entry. Before dispatch, the original body is kept in device-only SecureStore under `<backend>.<account>.owner-entry-attempt`, and an uncertain reply offers **Retry original outside booking**. Account deletion removes this key ([privacy](privacy.md)).

Players' rental and group details show "Paid at the venue …" and the venue's attendance record.

## Verification and rollout

`npm run test:operations` runs the rollback-only `booking-operations.sql` on embedded PostgreSQL. `npm run test:operations:local` (run alone) runs the same SQL on Docker, then uses real Auth/PostgREST:

- concurrent outside and player rentals for one court hour (one winner), six entry retries (one event);
- observed lock waits in both orders against sessions and blocks;
- six concurrent check-ins and payments (one event each), and mixed no-show/check-in (one winner);
- revocation-first, and the group start gate;
- the shipped desk and player clients, with one lost outside-rental reply;
- served Edge without Redis: entry 503 with no write, records 200.

Handler, domain and mobile tests cover the buckets, parsers and journal. Trusted test SQL moves bookings to "now" to stand in for time passing.

The migration is applied locally only. Hosted rollout needs T27–T30 first, then this migration and both functions redeployed. No new dependency or native module; reload Metro. Physical iPhone review is pending: accept/decline a request, record an outside booking (including airplane mode, then retry), and check in, pay and complete on the front desk. The player then sees the record.
