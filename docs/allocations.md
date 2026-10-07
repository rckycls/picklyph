# Shared court allocations (T21)

`private.court_allocations` is the single authoritative court inventory. Owner blocks (outside bookings, maintenance, walk-ins), private rentals and open-play sessions all consume the same rows. T21 adds the table, server-only primitives, owner/admin block commands and tests; T22 adds court hours, the owner calendar, the Edge wiring and displacement guards. Rental snapshots (T23), booking lifecycles (T24+) and any scheduled cleanup (T32) are later tasks. Redis never locks or caches inventory.

## Model

Each row is a half-open `[starts_at, ends_at)` UTC interval on one court: touching intervals do not overlap. Boundaries are on 30-minute marks (Manila is UTC+8, so UTC and Manila marks coincide), length is at most 24 hours, and the range stays within Manila 2000–2099. `kind` is `block`, `rental` or `session`. `expires_at` null means **firm**; otherwise the row is a **hold**. `state` is `active`, `released` or `expired`; `ended_at` records when a row stopped consuming inventory. Commands never delete rows.

A row is **live** at time *t* when `state = 'active'` and (`expires_at` is null or `expires_at > t`). SQL `private.allocation_live` and TypeScript `isLiveAllocation` share this rule. A partial GiST exclusion constraint (`btree_gist`) forbids two `active` rows on one court from overlapping, even for a trusted direct insert.

An acquisition must also lie inside contiguous **resolved court hours** (`private.court_within_hours` over `private.resolve_court_hours`: T19 venue hours narrowed by the court's T22 rules), including across midnight. An unconfigured venue schedule has no hours. Open hours are a prerequisite, never availability.

## Concurrency

Lock order for every inventory write: **venue** (`FOR SHARE`, or the caller's stronger editor lock), then **court** (`FOR NO KEY UPDATE`), then allocation rows. Acquisitions on one court therefore serialize, while different courts proceed in parallel. Venue-first editors (T11 curation, T18 court saves, T19 schedule saves) cannot interleave with an acquisition. The clock (`clock_timestamp()`) is read once, after the locks. An overlap returns `allocation_conflict`. The exclusion constraint is a backstop that maps to the same error.

## Holds and expiration without cron

A hold's expiry must be later than the server clock, no later than `starts_at`, and at most 2 hours away (the locked approval-hold maximum). Later commands choose the exact value with `holdUntil(at, startsAt, minutes)`, e.g. 15 minutes for payment. Expiry needs no job:

- Reads return live rows only, so an elapsed hold disappears at its expiry instant.
- Before checking for conflicts, an acquisition marks that court's elapsed holds `expired` (`ended_at = expires_at`).
- `private.allocation_renew(id, hold_until)` moves a live hold's expiry or, with null, makes it firm. If the hold already elapsed or was released, it fails with `allocation_ended`: late payment never revives inventory. A competing acquisition that marked the hold expired wins over a renewal waiting on the same row.
- `private.allocation_release(id)` is idempotent: `released` once, then `existing`. An elapsed hold reports `expired`.

A future cleanup job may mark elapsed rows, but correctness never depends on it.

## Retries

`(requested_by, request_id)` is unique. Repeating an acquisition with the same court, kind and interval returns the original row as it stands now (`outcome: existing`), even if it has since been released or has expired; a retry never re-acquires inventory. The hold expiry is not compared, because callers recompute it per attempt. Reusing a key with different parameters returns `request_reused`. After an uncertain reply, retry with the same `request_id`.

## Interfaces

Server-only primitives (no API role can execute them; callers authorize first and run them inside their own transaction, so any later failure rolls them back):

- `private.allocation_acquire(court, kind, starts, ends, hold_until, requester, request)` → `{outcome: created|existing, allocation}`. It refuses suspended venues and inactive courts.
- `private.allocation_release(id)`, `private.allocation_renew(id, hold_until)`, `private.allocation_list(venue, from, to, at)`, `private.court_within_hours(court, starts, ends)` (T22; replaced the venue-wide `allocation_within_hours`).

Service-role RPCs for owners/admins, with the same editors and locks as T19 schedule saves (current verified owners of approved/verified venues; current admins on non-suspended venues; never moderators):

- `court_allocation_block(actor_user_id, target_court_id, block_request_id, block_starts_at, block_ends_at)` creates a firm `block` and audits `allocation.block` in the same transaction (not on retries).
- `court_allocation_release(actor_user_id, target_allocation_id)` releases blocks only; rentals and sessions return `managed_allocation` and change through booking commands. It audits `allocation.release`.
- `court_allocation_read(actor_user_id, target_venue_id, range_start, range_end)` returns `{venue_id, allocations}` (live only, at most 31 days). It takes no locks and carries no requester or request IDs.

`supabase/functions/_shared/allocations.ts` wraps these RPCs for Edge handlers (`createAllocationCommands`) and maps hints to `ALLOCATION_STATUS`: `invalid_input` 400; `not_owner`, `managed_allocation` 403; `venue_unavailable`, `court_unavailable`, `allocation_not_found` 404; `outside_hours`, `allocation_conflict`, `request_reused`, `allocation_ended` 409; anything else is a retryable 503. The actor must come from verified Auth. `packages/domain/src/allocation.ts` holds the contracts and the strict `readAllocationBlock` / `readAllocationRangeQuery` readers. T22 exposes block/release through `owner-schedules` (see docs/schedules.md); the calendar reads inventory with `owner_calendar_read`, not `court_allocation_read`.

## For later tasks

- **T22 (done):** court hours/closures, owner calendar and Edge wiring. Venue schedule saves and court-hours saves refuse to leave any live, unended allocation outside its court's hours (`hours_conflict`); a `courts` trigger refuses deactivating a court with one (`court_allocated`). Both run under the venue editor lock that every acquisition shares first.
- **T23/T24/T27:** authorize the player (approved, verified, configured, not suspended) and call `allocation_acquire` with `rental`/`session` in the booking transaction. Apply the `hold-create` Upstash guard (fail closed) before it. Snapshot prices/policies separately.
- **T47:** `requested_by` has no FK (retention policy pending); deleting a venue or court cascades to its rows.

## Verification and rollout

Migration `20261008030000_court_allocations.sql` (creates `btree_gist` in `extensions`) and T22's `20261008060000_owner_calendar.sql` are applied locally only. Hosted staging still needs T18–T22 migrations applied in order.

`npm run test:allocations:local` (local Docker/Supabase only) runs the rollback-only `supabase/tests/allocations.sql`, then real concurrent PostgREST calls (identical/overlapping requests yield one winner, adjacent/cross-court requests all succeed, simultaneous retries create one row), separate `psql` sessions (a competitor waits on the court lock, conflicts after commit, acquires after rollback), real-time hold expiry with no sweep, release, client RPC/private-table denial and revocation. It removes its own accounts, venue, allocations and audit rows. `test:directory` runs the same SQL suite on embedded PostgreSQL (PGlite suites that load all migrations need the `btree_gist` contrib extension), and `test:domain` covers the contracts.
