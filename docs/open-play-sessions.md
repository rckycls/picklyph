# Owner open-play sessions (T27)

Verified owners schedule open play from **Venues → Open-play sessions**. Sessions reserve one or more named courts using the same inventory as rentals and owner blocks. Creation is all-or-nothing. T28 adds the group booking API ([session-bookings.md](session-bookings.md)); the player UI arrives in T30. T27 itself does not sell participant spots or execute payments.

## Owner workflow and contracts

Choose a title, Manila date/time, active courts, participant capacity, group limit and price per person in PHP. Courts must be open for the entire interval. Boundaries are 30 minutes apart, duration is 30 minutes to 24 hours, and start must be strictly future and within the server's rolling 60-day horizon. Overnight sessions are supported. Capacity is 1–200; the UI initially offers 12 spots and a group limit of 4, reducing that limit for smaller capacities. Price is a nonnegative integer number of centavos; price × capacity must fit a safe JavaScript integer.

The server captures immutable title/time/courts/capacity/group limit/price, effective confirmation/payment policy and merchant state, policy/schedule/court-hours revisions, 120-minute approval hold, 15-minute payment hold and 24-hour refund cutoff. Later venue edits cannot alter an existing session. Court-hour/schedule/deactivation guards already protect its allocations. T35 must check current merchant activation again before any checkout.

Sessions are immutable after creation: cancel an empty future session, then create a new one. Cancellation releases every assigned court and records one audit event. Started sessions and sessions with `reserved_spots > 0` cannot be cancelled through this command; T31 adds cancellation with participant bookings/refunds. Suspension blocks new creation but permits current owners to read history and cancel empty future sessions. A revoked owner cannot read, cancel or retry the session. Admin/moderator roles alone grant no session access.

`owner-sessions` independently verifies every bearer with `getUser`; callers never supply the actor. GET and POST responses are private/no-store, without CORS. URL limit is 2048 characters and streamed JSON body limit is 4096 bytes. Strict contracts reject extra body fields and duplicate query keys.

- `GET ?venue_id=UUID[&after_id=UUID]` → `{venue_id,at,sessions,next_cursor}`. UUID keyset pages contain at most 25 sessions, including cancelled/history records. The owner UI loads at most 200, sorts loaded records by start time and refreshes page one after changes/focus/foreground return. UUID paging is not chronological completeness.
- `POST {kind:"create",venue_id,request_id,court_ids,title,starts_at,ends_at,capacity,group_limit,price_centavos}` → `{outcome:"created"|"existing",session}`.
- `POST {kind:"cancel",session_id}` → `{outcome:"cancelled"|"existing",session}`.

Known refusals include `not_owner`403, unavailable venue/court/session404 and conflict/reused-request/outside-hours/occupied-session/started-session409. Invalid input is400. Transient infrastructure errors return sanitized503 with Retry-After; rate limits return429. Creation uses the fail-closed `hold-create` guard, requiring an enforced allowance. Cancellation uses `cancel`, reads use `owner-read`; both continue under Redis outage/SDK timeout.

## Transaction and retry rules

Service-only `owner_session_create|cancel|read` authorize current venue links inside their transaction. `private.open_play_sessions` and `private.session_courts` have RLS, no API-role grants, and no direct service writes. The immutable trigger protects request/snapshot/time/capacity. Public wrappers alone are executable by service role; private helpers remain inaccessible to API roles. Minimal `session.create|cancel` directory audit events share the mutation transaction, so failed auditing rolls back the session and allocations.

Creation serializes `(actor, request_id)` through an advisory transaction lock, then locks venue → current owner link → all selected courts in sorted UUID order → merchant state. It reads the authoritative clock after these locks. Each assigned court receives a firm `session` allocation via `private.allocation_acquire`; allocation retry IDs are generated internally, while the session owns the original request identity. If the last court conflicts or is closed, earlier acquisitions and expired-hold cleanup roll back. Half-open intervals allow touching sessions/rentals. No Redis inventory or cron dependency exists.

Retry compares canonical court ordering, normalized instants (the create function fixes its timezone to UTC), title, capacity, limit and price. It returns the original session/snapshot/status even after policy edits or cancellation; it never revives court inventory. Changed input with the same key fails. Duplicate cancellation records one audit and releases each allocation once.

The mobile creation journal persists the exact normalized request **before** dispatch in device-only SecureStore under backend/account identity. Network/auth/429/503/malformed-success replies retain the request across restart and sign-in. Another creation is blocked until recovery resolves it. There is no automatic submission. Foreground/focus reads revalidate access; old replies cannot populate a different account's keyed screen. Cancellation retries use the same session ID. Sign-out keeps an uncertain creation; T47 account deletion must clear `.session-attempt` alongside rental recovery. Web fallback is memory only.

## For T29/T31

T28 implements participant inventory: `reserved_spots` counts live pending and confirmed groups, changes only under the venue → session lock, and elapsed holds are released on access (including before this empty-session cancellation check). Owner reads report the effective count. T29 walk-ins must reuse that lock order and counter, and may need to relax T28's one-live-group-per-player index for owner-entered groups. Each group snapshots the immutable session price/policy; current schedules do not reprice it. Read/cancel T27 wrappers reveal no participant names. Extend occupied-session cancellation only alongside audited participant release/refund handling. Court allocations remain firm for the entire session independent of the number of spots sold.

## Verification and rollout

Run `npm run test:sessions` (embedded PostgreSQL/PostGIS SQL and handler/outage tests), `npm run test:sessions:local` (Docker SQL, real Auth/PostgREST, observed independent lock races, mobile recovery and served Edge), `npm run test:owner`, `test:domain`, `test:directory`, `typecheck`, `lint`, `functions:check`, `functions:lint`, and `bundle:ios`. The local harness targets loopback/local Docker, removes only generated fixtures/env/child processes and compares pre-existing IDs. Run local fixture suites one at a time.

Migration `20261008210000_open_play_sessions.sql` is applied locally only. Hosted rollout needs this migration plus `owner-sessions` with the pinned import map and existing `DISCOVERY_SUPABASE_*`/Upstash configuration. No new package or native module is required. Physical iPhone checks remain: owner-only entry, multi-court and overnight form, PHP pricing/group limits, conflict recovery, restart after uncertain creation, foreground access revalidation, cancellation, large text and VoiceOver. No device review or hosted acceptance is claimed by automated checks.
