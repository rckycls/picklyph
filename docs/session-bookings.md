# Open-play group booking API (T28, walk-ins T29)

`/functions/v1/session-bookings` lets signed-in players reserve a named group in a T27 open-play session and pay on arrival. Every bearer is independently verified with `getUser`; the server derives the actor and calls service-only RPCs through an isolated client with no caller session or headers. Responses are `Cache-Control: private, no-store` without CORS. GET URLs are at most 2048 characters. POST JSON is streamed and capped at 16 KiB (`MAX_SESSION_BOOKING_BYTES`), larger than other commands so a full group of names fits. Unknown fields and duplicate query parameters fail validation. Owners also enter walk-ins here (T29, below). Players use it from the app (T30, below). There is no payment execution or occupied-session venue cancellation (T40). Owner approvals, attendance and arrival payments are in the [owner front desk](booking-operations.md) (T31).

## Reads

- `GET ?section=sessions&venue_id=UUID[&after_id=UUID]` → `{venue_id,at,sessions,next_cursor}`: upcoming scheduled sessions at a bookable venue, ordered by start time then ID, 25 per page. The cursor is the last session's ID.
- `GET ?section=session&session_id=UUID` → `{at,session}`: one session, including cancelled ones.
- `GET ?section=booking&booking_id=UUID` → `{booking}`: the booking player or a current owner of the session's venue.
- `GET ?section=history[&after_id=UUID]` → `{bookings,next_cursor}`: the caller's own player groups (never walk-ins they entered), ascending UUID pages of 25.
- `GET ?section=requests&venue_id=UUID[&after_id=UUID]` → `{bookings,next_cursor}`: a current owner's live pending groups, ascending UUID pages of 25.
- `GET ?section=walk_ins&session_id=UUID[&after_id=UUID]` → `{bookings,next_cursor}`: a current owner's walk-in groups for one session, in every status, ascending UUID pages of 25.

A session offer is `{id,venue_id,status,snapshot,available_spots}`. Its snapshot is the immutable T27 snapshot without schedule, court-hours or policy revisions. It never includes participant names, the owner or other bookers. A venue is bookable when it is approved, verified and still has an owner link. Otherwise `sessions` and `session` return `venue_unavailable`. Reads never write: an elapsed hold reads as `expired` and its spots read as available before any write releases them.

## Reserve a group

```json
{
  "kind": "request",
  "session_id": "<uuid>",
  "request_id": "<new UUID retained across retries>",
  "participants": ["Ana", "Ben"],
  "expected_total_centavos": 50000
}
```

Names are trimmed and must be 1–60 characters, with no control characters and no duplicates (ignoring case). Order is preserved. The group size is the number of names, from 1 up to the session's `group_limit`. `expected_total_centavos` must equal the session's immutable per-person price × names. It confirms the total the player reviewed; it never sets the price. A mismatch returns `stale_quote`.

The immutable session snapshot governs policy: later venue policy edits do not change an existing session. Instant sessions create `confirmed`. Approval sessions create `pending`, holding spots until `min(DB time + 120 minutes, starts_at)`. Online-only sessions return `arrival_unavailable`. Every group is `payment_method: arrival`, `payment_status: unpaid`.

Each player may hold one live (pending or confirmed) group per session, enforced by a check and a partial unique index over player bookings (walk-ins are excluded). This stops the group limit from being split across several bookings. After a cancellation, decline or expiry, the player can book again with a new request ID.

A booking carries its ID, session ID, `source` (`player` or `walk_in`), effective status, ordered participants, spots, hold expiry and timestamps. Its snapshot holds venue, title, courts, times, per-person price, spots, total, PHP/Manila, effective policy and revision, and hold/refund constants. It never includes account IDs or retry keys.

## Walk-ins (T29)

```json
{
  "kind": "walk_in",
  "session_id": "<uuid>",
  "request_id": "<new UUID retained across retries>",
  "participants": ["Ana", "Ben"],
  "expected_total_centavos": 50000
}
```

A current owner of the session's venue (approved, verified, still linked) enters a named group that has arrived in person. Names, the `group_limit`, the exact total and capacity follow the same rules as a player request, under the same venue → session lock and `reserved_spots` counter, so walk-ins and player groups can never oversell together. A walk-in is `confirmed` on entry, `payment_method: arrival`, `payment_status: unpaid`, and never holds or expires. Walk-ins are accepted from session creation until `ends_at` (players stop at `starts_at`) and regardless of the session's payment policy, because the venue collects payment in person. Owners may enter any number of walk-in groups; the one-live-group rule applies only to player bookings, so an owner who entered walk-ins can still book their own player group.

The walk-in shares the `(actor, request_id)` retry key space with player requests and its canonical input includes the kind, so one key can never name both. Retrying returns `existing` with the current state (including a removed walk-in, never revived) and requires current ownership, so a revoked owner cannot replay a key to read names. A walk-in records one `walk_in` event. Players, admins and moderators get `not_owner`.

## Lifecycle

- `POST {kind:"accept",booking_id}`: a current owner confirms a pending group. This needs an approved venue (`venue_unavailable` under suspension). Accepting a confirmed group returns `existing`.
- `POST {kind:"decline",booking_id}`: a current owner declines a pending group and releases its spots. This works during suspension.
- `POST {kind:"cancel",booking_id}`: the booking player cancels a pending or confirmed group before the session starts and releases its spots. Owners cannot cancel a player's group here; venue cancellation with refunds is T40. For a walk-in, any current owner (not only the one who entered it) removes it until the session ends; players cannot. Accepting a walk-in returns `existing`; declining one is `invalid_transition`.

Replies are `{outcome: created|existing|changed|expired, booking}`. A pending hold that elapsed before the command returns `expired`. It is never accepted or cancelled, and it is never revived. Changes after the session starts, or out of order, return `invalid_transition`. Admin or moderator roles alone grant no access.

| Reason | HTTP |
| --- | --- |
| `invalid_input` | 400 |
| `player_required`, `not_player`, `not_owner` | 403 |
| `booking_not_found`, `session_not_found`, `venue_unavailable` | 404 |
| `session_full`, `group_limit_exceeded`, `already_booked`, `stale_quote`, `session_cancelled`, `session_started`, `session_ended`, `arrival_unavailable`, `request_reused`, `invalid_transition` | 409 |

Infrastructure failures return a sanitized `503` with `Retry-After: 5`. Requests use the fail-closed `hold-create` guard; acceptance and walk-ins use `owner-edit`. Both require an enforced allowance, so Redis outages, SDK timeouts and degraded allowances return 503 with no write. Decline and cancellation use `cancel`, and reads use `owner-read`; these continue during a Redis outage.

## Transaction and inventory rules

`private.session_bookings` and `private.session_booking_events` have RLS on, no API-role grants and no direct service-role access. Only `session_booking_request|change|read` and `session_walk_in` are executable, and only by the service role. A guard trigger keeps identity, source, participants, spots, snapshot and request immutable; a check keeps walk-ins out of `pending`. It allows only `pending → confirmed|declined|cancelled|expired` and `confirmed → cancelled`. Events cannot be updated. Every booking change and its event commit in the same transaction, so a failed event rolls back the booking and its spots.

Every participant mutation locks **venue (share) → session (for update)**, then reads the database clock. `open_play_sessions.reserved_spots` is the single authoritative count of live spots (pending holds plus confirmed groups). It changes only under that session lock, and the table check `reserved_spots between 0 and capacity` backs up the explicit `session_full` refusal. Court allocations stay firm for the whole session, whatever the number of spots sold. T27 owner cancellation locks venue → owner link → courts → session, which is compatible with this order.

Holds expire without cron. Under the session lock, `private.session_expire_holds` marks elapsed pending groups `expired` (keeping `updated_at = expires_at`), records one `expire` event each (with a null actor) and subtracts their spots. Every request, accept, decline and cancel on that session runs it, and so does T27 empty-session cancellation. A session whose only groups are elapsed holds can therefore be cancelled. Reads compute the same effective state, and T27 owner reads now report effective `reserved_spots`.

Retries serialize on `(player, request_id)` with an advisory lock. The canonical request is the session, request ID, trimmed names and expected total. Repeating the same request returns `existing` with the current state, which may be cancelled, declined or expired. Changing the input under the same key returns `request_reused`.

## Player app (T30)

Discover's venue sheet shows **Join open play** for verified venues with active courts. It opens `/play/venue/[id]`, the venue's upcoming sessions (25 per page). `/play/session/[id]` shows one session and takes one name per person; `/play/booking/[id]` shows a group with cancellation. Bookings has a **Court rentals / Open play** switch (`/bookings?view=play`). All three routes sign in in place.

- **Server truth only.** `src/features/openPlay/client.ts` parses offers, pages, history and replies strictly, and anything inconsistent counts as an uncertain reply. Spots left, started and full labels use the read's database time (`at`), never the device clock. The total shown is the immutable per-person price × names, the same number sent as `expected_total_centavos`. A success must echo the session, the ordered names and that total.
- **Local guidance, server checks.** `model.ts` offers name rows up to `min(group_limit, available_spots)`, trims names, ignores blank rows, and explains limit, spot, repeat, length, started, full, cancelled and online-only cases before sending. The server repeats every check under the session lock.
- **Durable original request.** Before dispatch, the request (session, request ID, names, total) is saved in device-only SecureStore under `<backend>.<account>.group-attempt`. A lost reply, 401, 429 or 503 keeps it. The Reserve and Bookings screens offer **Retry original group request**, and reserving another group waits until it resolves. A definitive refusal other than `request_reused` clears it. Sign-out keeps it; **T47 must delete it on account deletion.** It holds participant names, which stay on this device.
- **Status.** Detail refreshes on focus, foreground and every 30 seconds. While a refresh is pending or has failed, the screen labels the details as the last received record. Pending shows the hold end. Cancellation asks first; an uncertain reply offers **Retry original cancellation**, and a repeated cancel returns the same cancelled record.
- **Shared with rentals.** `useRentalRead`, `useRetryWait`, `mergeHistory`, `BookingMascot` and the celebration store now accept either booking kind. A fresh confirmed reply after a request cheers once, as for rentals.

Physical iPhone review is pending. Steps: open a verified venue with a scheduled session; join with two names; check the total, policy and spots; for an approval session, check the hold end; cancel and confirm the spots reopen; turn on airplane mode mid-request, then retry the original from Bookings → Open play.

## Verification and rollout

Run `npm run test:session-bookings`, which covers embedded PostgreSQL/PostGIS SQL (`session-bookings.sql`, `session-walk-ins.sql`), handler, outage and dependency tests. Run `npm run test:session-bookings:local` alone. It covers Docker SQL, real Auth/PostgREST concurrency (including walk-ins racing player groups), observed lock waits in both orders and served Edge. Its T30 step drives the actual mobile open-play parsers and journal through real Auth and PostgreSQL, with one lost committed reply. Also run `test:open-play`, `test:sessions`, `test:sessions:local`, `test:domain`, `test:directory`, `typecheck`, `lint`, `functions:check` and `functions:lint`. The local harness targets only loopback/local Docker, removes its own fixtures, accounts, audits and temp env, and compares pre-existing IDs. Its served-Edge step waits for a fresh edge container: a previously killed `functions serve` on Windows leaves its container running, and Kong can briefly route to it while it is replaced.

Migrations `20261009000000_session_bookings.sql` and `20261009030000_session_walk_ins.sql` are applied locally only. Hosted rollout needs the T27 migration and `owner-sessions`, then these migrations and `session-bookings`, using the pinned import map and the existing `DISCOVERY_SUPABASE_*`/Upstash configuration. No new package or native module is required.
