# Venue hours and rates (T19)

Venue-wide opening hours, hourly PHP rates and dated exceptions are stored privately. T19 adds the schema, authorized commands and resolver; the owner form, calendar, inventory, reservability and booking-price snapshots belong to later tasks. A resolved open interval does not promise that any court is free.

## Rules

`VenueSchedule` in `packages/domain/src/schedule.ts` contains `weekly` (exactly seven arrays, Sunday index 0) and `exceptions` (at most 120 unique dated overrides). An empty weekly array has no opening starting that day; it may still receive yesterday's overnight hours. An empty dated override closes the **entire Manila civil date**, including incoming overnight hours. A special-hours override also replaces that whole date, suppresses incoming spill and uses its own rates. Its overnight portion continues into tomorrow unless tomorrow itself has an override.

Each day has at most four sorted, disjoint opening windows. Minutes are measured from that opening day's midnight in **Asia/Manila**: `1320` is 22:00, `1560` is 02:00 the next day. Starts are below 1440; ends are strictly later; one window lasts at most 24 hours. All boundaries use 30-minute increments, matching the locked rental increment. Adjacent windows/bands are allowed, as are deliberate closed gaps between windows. Endpoints are half-open: the end belongs to the next interval.

Each window contains 1–16 sorted rate bands covering its hours exactly, with no overlaps or unpriced gaps. `hourly_centavos` is a nonnegative safe integer (maximum 9007199254740991); zero is a valid free rate. Overnight bands use the same minute offsets as the window. Missing exception rates never fall back to weekly rates. No total is computed here: T23 must use checked arithmetic and define price rounding/snapshots.

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

For T21/T22, call `private.resolve_venue_schedule(venue_id, first_date, day_count)` inside the authorized database transaction; do not expose private helpers or treat this as allocation availability. Schedule edits currently have no allocations to protect. T22 must add the active-allocation guard **to this save command**, as well as T18 court deactivation, before booking mutations ship. T23 uses the rate bands but must snapshot prices/policies. Expired allocation logic remains PostgreSQL's responsibility.
