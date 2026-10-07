# Venue hours and rates (T19)

Venue-wide opening hours, hourly PHP rates and dated exceptions are stored privately. T19 adds the schema, authorized commands and resolver. T22 adds court hours/closures, the owner calendar and hours screens, and displacement guards (see [Court hours, calendar and guards](#court-hours-calendar-and-guards-t22)); reservability and booking-price snapshots belong to later tasks. A resolved open interval does not promise that any court is free.

## Rules

`VenueSchedule` in `packages/domain/src/schedule.ts` contains `weekly` (exactly seven arrays, Sunday index 0) and `exceptions` (at most 120 unique dated overrides). An empty weekly array has no opening starting that day; it may still receive yesterday's overnight hours. An empty dated override closes the **entire Manila civil date**, including incoming overnight hours. A special-hours override also replaces that whole date, suppresses incoming spill and uses its own rates. Its overnight portion continues into tomorrow unless tomorrow itself has an override.

Each day has at most four sorted, disjoint opening windows. Minutes are measured from that opening day's midnight in **Asia/Manila**: `1320` is 22:00, `1560` is 02:00 the next day. Starts are below 1440; ends are strictly later; one window lasts at most 24 hours. All boundaries use 30-minute increments, matching the locked rental increment. Adjacent windows/bands are allowed, as are deliberate closed gaps between windows. Endpoints are half-open: the end belongs to the next interval.

Each window contains 1–16 sorted rate bands covering its hours exactly, with no overlaps or unpriced gaps. `hourly_centavos` is a nonnegative safe integer (maximum 9007199254740991); zero is a valid free rate. Overnight bands use the same minute offsets as the window. Missing exception rates never fall back to weekly rates. Schedule reads do not compute a total; T23 [rental snapshots](booking-rules.md#authoritative-rental-snapshots-t23) use current resolved court intervals, exact checked arithmetic and half-up rounding once on the total.

Both TypeScript and SQL reject overlapping opening/rate rules, including spill across the Saturday/Sunday boundary and exception spill into the following ordinary date. Validation checks the underlying weekly rules independently of exceptions, so an override cannot hide an invalid recurring schedule. Dates are strict ISO dates in 2000–2099; resolved query ranges contain 1–31 civil dates and stay in that range.

## Endpoint

`GET /functions/v1/owner-schedules?venue_id=<uuid>&start_date=2026-10-05&days=2` returns:

```json
{
  "venue_id": "<uuid>",
  "revision": "1",
  "schedule": { "weekly": [[], [], [], [], [], [], []], "exceptions": [] },
  "intervals": []
}
```

An unconfigured venue returns `revision:null`, `schedule:null`, `intervals:[]`; an explicitly all-closed schedule has a revision and rules. UTC intervals contain `starts_at`, `ends_at`, `hourly_centavos`, sorted and clipped to the requested dates, split at midnight/rate changes. UTC timestamps include explicit offsets; clients must compare instants, not timestamp spellings. The SQL resolver uses `AT TIME ZONE 'Asia/Manila'`, independent of the DB session timezone. The TypeScript resolver reuses T09's contemporary Manila conversion and money validation.

`POST` accepts exactly `venue_id`, `expected_revision` (null on first save, otherwise the exact decimal string last read), and `schedule`. Example Monday overnight rules:

```json
{
  "venue_id": "<uuid>",
  "expected_revision": null,
  "schedule": {
    "weekly": [[], [{
      "start_minute": 1320, "end_minute": 1560,
      "rates": [
        { "start_minute": 1320, "end_minute": 1440, "hourly_centavos": 25000 },
        { "start_minute": 1440, "end_minute": 1560, "hourly_centavos": 30000 }
      ]
    }], [], [], [], [], []],
    "exceptions": [{ "date": "2026-10-06", "windows": [] }]
  }
}
```

This opens Monday 22:00–midnight and closes Tuesday, including Monday's planned 00:00–02:00 spill. Saves replace the full schedule, increment its independent revision and return rules with `intervals:[]`; read the desired date range afterward. A stale revision returns 409 `version_conflict`. Concurrent first saves produce one success and one conflict. Retries after an uncertain response must read/reconcile before resaving; there is no separate request-ID mechanism. Invalid input returns 400, non-editor 403, unavailable/suspended venue 404. No actor/body fields are accepted.

## Authorization, storage and audit

Every request verifies the bearer independently with Auth `getUser`. The stateless service client never receives the caller's Authorization. `venue_schedule_read`/`venue_schedule_save` execute only for `service_role`; private helpers and all four private tables have no API-role grants and RLS is enabled. SQL independently validates every rule.

Verified owners edit their own **approved, verified** venues under T18's venue/link locks. Current admins may prepare draft/approved schedules, including unclaimed venues, under T11's role lock then venue lock. Neither may edit suspended venues. Moderators gain no schedule access. Reads retain the same locks to return one coherent revision/rules/intervals snapshot. Revocation and suspension serialize with writes. The save writes `schedule.update` to the private directory audit in the same transaction; audit failure rolls back the rules and revision. No payloads or credentials are audited. Schedule saves do not change the directory detail version.

The endpoint shares T18's verified-user `owner-read` (60/min) and `owner-edit` (20/min) Upstash buckets. JSON streams are capped at 256 KiB (a practical combined payload limit in addition to per-rule limits). The limiter precedes body reads/mutations: outage/timeout writes return retryable 503; bounded reads may continue. 429 preserves `Retry-After`. Replies are private/no-store, there is no browser CORS, Auth/DB requests have 8-second deadlines, and unknown errors are sanitized. Reuse existing `DISCOVERY_SUPABASE_*`, `PICKLY_ENV`, Upstash and rate-key secrets; no new credentials or dependency.

## Verification and rollout

Migration `20261007210000_venue_schedules.sql` follows T18 and is applied locally. Hosted staging deployment remains separate: apply pending T18/T19 migrations, then deploy `owner-schedules` using `supabase/config.toml` (independent bearer verification, explicit import map). No mobile/native UI changes or device acceptance are claimed.

`npm run test:schedules:local` requires local Docker/Supabase. It runs rollback-only SQL assertions, then real Auth/PostgREST through the shipped handler/dependencies (owner/admin saves, concurrent versions/audit, revocation and RPC denial), and the actual served Edge function (forged JWT, bounded read, Redis-less write denial). Fixture accounts, schedule/venue, audit and temporary local credentials are removed; only its own child server is stopped. The script never reads hosted/mobile env. `test:directory` includes embedded PostgreSQL/PostGIS permission/audit assertions and SQL/TypeScript parity over 18 configurations; `test:domain` includes time-boundary and host-zone tests. Run typecheck, lint and Edge checks too.

Inside authorized transactions, call `private.resolve_court_hours(court_id, first_date, day_count)` (or `resolve_venue_schedule` for venue-wide rules); do not expose private helpers or treat hours as availability. T23 uses the rate bands but must snapshot prices/policies. Expired allocation logic remains PostgreSQL's responsibility.

## Court hours, calendar and guards (T22)

**Court rules** (`CourtHours` in `packages/domain/src/calendar.ts`) only narrow venue hours, so venue rates still price every open minute. `weekly` is null (follow the venue's weekly hours) or seven arrays of at most four sorted same-day windows (0–1440, 30-minute marks, adjacent allowed, no overnight spill: list 23:00–24:00 on one day and 00:00–01:00 on the next). `closures` holds up to 120 unique Manila dates; a closure closes the court for the whole civil date, including incoming overnight hours. Resolution intersects each venue interval with the court's ranges for that interval's civil date (`private.resolve_court_hours`, mirrored by `resolveCourtHours`; SQL/TypeScript parity is tested). Rules live in private `court_schedules`/`court_hours`/`court_closures` with an independent per-court revision; unconfigured courts read as revision null, `{weekly:null, closures:[]}`.

**Endpoint additions** (same verification, limits, body cap and no-store replies as above):

- `GET ?venue_id&start_date&days&section=calendar` (1–7 days) → `{venue_id, name, start_date, days, at, schedule_revision, courts:[{court_id, revision, hours, name, status, intervals}], allocations}`. One SQL statement, so courts, resolved hours and live inventory (elapsed holds excluded) share one snapshot and the server clock `at`. No editor lock.
- `POST {kind:"block", court_id, request_id, starts_at, ends_at}` and `{kind:"release_block", allocation_id}` → T21 `court_allocation_block`/`court_allocation_release` (`{outcome, allocation}`). Retry a block with the same `request_id`; rentals/sessions return 403 `managed_allocation`.
- `POST {kind:"save_court_hours", court_id, expected_revision, hours}` → `{court_id, revision, hours}`; audited as `schedule.court_update`.
- A body without `kind` is still the T19 venue schedule save. Unknown kinds or extra keys return 400.

Refusals: 409 `outside_hours`, `allocation_conflict`, `request_reused`, `version_conflict`, `hours_conflict`; 404 `court_unavailable`, `venue_unavailable`, `allocation_not_found`; 403 `not_owner`, `managed_allocation`.

**Guards.** Venue schedule saves and court-hours saves end with `private.require_hours_cover_allocations`: every live allocation that has not ended (blocks, bookings and unexpired holds; released, expired and past rows are ignored) must still lie inside its court's contiguous hours, else the whole save rolls back with `hours_conflict`. A `courts` trigger refuses deactivating a court that has such an allocation (`court_allocated`, also mapped by owner-venues and the admin console). Both run while the editor holds the venue lock that every acquisition takes first (`FOR SHARE`), so a block or booking cannot slip in before commit; concurrent tests show exactly one side wins. The guard checks each live future allocation against resolved hours, which is linear in upcoming inventory; revisit if venues accumulate thousands of future rows.

**Mobile.** Owner mode → Venues → *Court calendar* (`/owner/calendar/[id]`): one Manila day of every court with hours, blocks, rentals, sessions and holds, block creation from free half hours (blocks stay within the day; block an overnight booking as two blocks) and release with confirmation. *Hours and closures* (`/owner/hours/[id]`): venue weekly stretches with peso rates (touching stretches become one opening period; later stretches may continue past midnight), venue closures (empty dated exceptions; pickly-set special hours are kept), and each court's own hours and closures. Past closures are dropped on save. Both screens use `VerifiedOwnerGate`.

**Rollout.** Migration `20261008060000_owner_calendar.sql` (replaces `allocation_acquire` and `venue_schedule_save` bodies, drops `allocation_within_hours`) is applied locally only. Hosted staging needs T18–T22 migrations in order, then the `owner-schedules` redeploy. `npm run test:calendar:local` runs the rollback-only `supabase/tests/calendar.sql` on Docker, real Auth/PostgREST through the shipped handler (court hours, calendar, overlapping-block and retry races, schedule-save/block and deactivation/block races, managed-hold protection, bypass/revocation), then the served Edge function (forged JWT, bounded read, Redis-less block denial). Device acceptance is separate.
