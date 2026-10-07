# Private rental booking API (T24)

`/functions/v1/rental-bookings` supports authenticated arrival rentals. Every bearer is independently verified with `getUser`; the server derives the actor and uses an isolated service client with no caller session/headers. Responses have `Cache-Control: private, no-store` and no CORS. GET URLs are at most 2048 characters; POST JSON streams are at most 4096 bytes. Unknown fields and duplicate query parameters fail validation.

## Review and reserve

`GET ?section=quote&court_id=<uuid>&starts_at=<offset-ISO>&ends_at=<offset-ISO>` returns `{quote}` containing court/venue IDs, UTC times, DB `quoted_at`, exact price bands/total, effective confirmation/payment/merchant policy and `expected_quote`. Current court hours and T09/T21/T23 rules resolve under venue→court→merchant locks. A quote does not allocate inventory or promise availability. Online-only effective policies return `arrival_unavailable`; `both` permits arrival. Inactive merchants use T20's effective arrival policy.

Reserve with the reviewed values:

```json
{
  "kind": "request",
  "court_id": "<uuid>",
  "request_id": "<new UUID retained across retries>",
  "starts_at": "2026-10-09T08:00:00+08:00",
  "ends_at": "2026-10-09T09:30:00+08:00",
  "expected_quote": {
    "total_centavos": 60000,
    "schedule_revision": "1",
    "court_hours_revision": null,
    "policy_revision": "0"
  }
}
```

The transaction re-resolves current price/policy and compares the review token exactly before allocation. `409 stale_quote` requires a fresh quote and another review. The token compares the review; it never supplies price authority. New rentals require an approved/verified venue with an owner, active court and complete configured court hours. The command calls `private.rental_acquire` inside the booking/event transaction, preserving T23 snapshots.

Effective `instant` creates `confirmed` with firm inventory. `approval` creates `pending`, expiring at `min(DB time + 120 minutes, starts_at)`. Both choose `payment_method: arrival`, `payment_status: unpaid`; confirmation does not record payment. Replies are `{outcome: created|existing, booking}`; booking contains ID (same as allocation ID), authoritative status/timestamps, allocation and original snapshot, without account IDs or retry keys.

An advisory transaction lock serializes each player/request UUID across courts. Repeating the same court/start/end returns the original booking/snapshot after edits, cancellation, suspension or expiry, without re-acquiring inventory. Changed identity parameters return `409 request_reused`. Retain the original key/body after an uncertain reply; a new key means a new reservation attempt. T21 shares `(requested_by,request_id)` with other inventory commands.

## Lifecycle and reads

POST accepts exactly `{kind: accept|decline|cancel|expire, booking_id: <uuid>}`.

| Command | Authorization | Effect |
| --- | --- | --- |
| `accept` | Current verified venue owner; approved venue | Live pending arrival becomes confirmed/firm; snapshot preserved. |
| `decline` | Current verified venue owner | Pending becomes declined; releases inventory, including during suspension. |
| `cancel` | Original player | Before start, pending/confirmed becomes cancelled and releases, including during suspension. |
| `expire` | Original player or current verified venue owner | Elapsed pending becomes expired and releases; early/terminal calls are unchanged. |

Commands lock venue→owner link (when needed)→court→allocation→booking and recheck authorization. Admin/moderator roles alone confer no owner access. Matching repeated actions return `existing` without duplicate events; incompatible transitions return `409 invalid_transition`. Late acceptance returns an expired booking when detected, or `409 allocation_ended` if expiry crosses the renewal boundary; neither revives inventory.

Reads project elapsed pending holds as expired using the DB clock without mutation. New acquisitions expire elapsed allocations on their court before conflict checking. Correctness does not depend on cron. Lifecycle commands persist expiry/events; T32 scheduled cleanup is separate.

| GET query | Response |
| --- | --- |
| `section=booking&booking_id=<uuid>` | `{booking}` for original player or current verified owner. |
| `section=history[&after_id=<uuid>]` | Original player's `{bookings,next_cursor}`, including terminal/expired bookings. |
| `section=requests&venue_id=<uuid>[&after_id=<uuid>]` | Current owner's live pending venue requests. |

Lists have ascending UUID keyset pages, maximum 25. A non-null cursor is the last returned ID, not a count or time order. New UUIDs may fall before a cursor; refresh from page one for new bookings. There is no caller-selected player history. Reads contain no player account IDs or emails.

## Guard, storage and errors

Verified-user Upstash buckets: request `hold-create` (fail closed, including instant firm rentals); accept `owner-edit` (fail closed); reads/quotes `owner-read` (bounded outage continuation); cancel/decline/expire `cancel` (outage continuation). Real denials return `429` with retry headers. Missing config, SDK fail-open timeout or hard deadline stops new reservations before RPC with `503 Retry-After: 5`. The handler also rejects a degraded/bypassed allowance for creation/acceptance. Bounded parsing selects the action before any mutation.

Migration `20261008120000_rental_bookings.sql` adds private RLS-enabled `rental_bookings` and `rental_events`. No API role, including service role, has direct table/sequence privileges. Events contain fixed action (`request|accept|decline|cancel|expire`), booking ID, verified actor UUID and DB time; updates are refused. Events, booking, snapshot and inventory commit atomically; event failure rolls the command back. No body/evidence/secret copies are stored. Public wrappers `rental_booking_quote|request|change|read` are service-role-only; private helpers remain denied to all API roles. The trusted server verifies identity/rate limits before RPC; service credentials are not a client interface.

Errors: malformed input `400`; missing/forged identity `401`; wrong player/owner `403`; missing booking/court or unavailable venue `404`; stale review, overlap, reused key, ended/invalid transition, horizon/hours/payment conflict `409`; infrastructure `503` with sanitized retry information. No raw database/Auth errors are returned.

## Verification and rollout

`npm run test:bookings` covers embedded PostgreSQL lifecycle/permissions/rollback and handler/guard behavior. `npm run test:bookings:local` covers rollback-only Docker SQL, real local Auth/handler/PostgREST lifecycle/races (retries, overlap, cross-court keys, accept/cancel, waited expiry, rate/policy edits), revocation/suspension, and served Edge forged JWT/outage creation/cancellation. It removes its own fixtures/accounts/events/temp credentials and stops its own child server. Contracts/regressions use `test:domain`, `test:directory`, `typecheck`, `lint`, `functions:check` and `functions:lint`.

Applied locally only. Hosted rollout needs T18–T24 migrations in order and `rental-bookings` deployment with its explicit import map, existing server Supabase secret names and configured Upstash guard. No new dependencies/native rebuild. T25 provides mobile review/history UI below; T26 expands race regressions; T31 adds operational/payment recording; T32 owns cleanup; T34–T36 own online checkout. No payment execution/refund/push/outbox/venue cancellation is implemented. Events/snapshots cascade on allocation/venue deletion; T47 must define retention before deletion ships.

## Mobile arrival rentals (T25)

Verified venue details offer **Choose a court & time**. Guests can open the same route and sign in there; unverified listings retain contact/directions. `/rental/venue/[id]` lists current active courts and accepts a Manila date, hour/half-hour start and 60–1440-minute duration in 30-minute increments. These are selection inputs, not availability slots. The server judges the future/60-day horizon and opening/rate coverage with its own clock.

Review shows the exact full PHP total, all rate bands, Manila start/end, confirmation and effective venue payment policy, selected arrival payment, approval-hold rules and cancellation terms. Confirmation is explicitly **unpaid**. Quotes clear on input changes, focus/foreground return and every reservation attempt; stale quotes require another fetch and explicit review. Online-only policies refuse arrival rentals.

Before dispatch, the original request UUID/body is saved in device-only SecureStore, scoped by backend and account. If persistence fails, no command is sent. Network, malformed success, 401, 429 and infrastructure replies retain that request; history and selection show **Retry original reservation**. Double taps are serialized across these screens. Reopening the app or signing into the original account recovers it. A verified response or definitive transaction rejection clears it. `request_reused` remains blocked for investigation in history. Do not delete recovery data to create another key while a result is uncertain. The journal contains no bearer, names or photo evidence; it is retained across local sign-out so an uncertain reservation remains recoverable by that account. Account deletion must handle this local key in T47. The non-native adapter is memory-only; the supported iPhone route uses SecureStore.

The Bookings tab shows bounded 25-row UUID pages, up to 200 loaded records, sorted newest-first within the loaded set. Refresh restarts from page one because new UUIDs can fall before an existing cursor. `/rental/booking/[id]` shows authoritative status, hold end, unpaid arrival payment, reference and the original immutable total/policy. Current public listing/court names supplement those records when available; IDs remain usable after listing removal. Focus/foreground and 30-second detail refreshes query the server; a local clock never changes status to expired or confirmed. Polling and retry controls honor server retry waits. Pending/confirmed bookings offer a cancellation confirmation dialog; cancellation retries keep the same booking ID. After uncertain cancellation, refresh status before booking a replacement.

`npm run test:rental:mobile` tests native-shaped HTTP responses, strict identity/price/policy parsing, midnight selection, account switches, delayed reads, refresh/foreground/expiry, paging, lost-reply recovery, storage failure, duplicate taps and cancellation retries. `test:bookings:local` also runs the shipped mobile client/journal against local Auth/handler/PostgREST, dropping a reply after commit and checking one allocation plus unchanged snapshots. Node hook drivers and iOS exports are automated evidence only.

Physical iPhone acceptance is pending, after hosted rollout: guest sign-in return; active-court/time selection and keyboard/large text/VoiceOver; a multi-band total and instant unpaid confirmation; approval hold/accepted/declined/expired status; a stale quote after owner rate/policy edits; two-player overlap; offline submit/restart/original retry; account-switch privacy; history paging/foreground refresh; cancellation confirmation, offline retry and final released status. Run through the dev client; no web preview or native screenshots are claimed.
