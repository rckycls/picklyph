# Booking notifications (T43, T44, T45)

Push is supplementary: the booking screens stay the source of truth. T43 adds push device registration, a
transactional outbox fed by booking events, and a worker that delivers through the Expo push service. T44
adds one-hour reminders and opening the right screen from a tapped push. T45 adds account-wide alert
switches, an explanation before iOS asks for permission, and sign-out that removes the phone first.

## Who hears about what

Booking events already exist (`private.rental_events`, `private.session_booking_events`). An after-insert
trigger on each writes outbox rows **in the event's own transaction**, so a rolled-back command leaves no
notification, and a committed one always has its rows.

| Event | Recipients | Kind |
| --- | --- | --- |
| Player request, approval policy (pending) | the venue's current owners | `booking.requested` |
| Player request, instant policy (confirmed) | the venue's current owners | `booking.created` |
| Owner accepts / declines | the player | `booking.accepted` / `booking.declined` |
| Hold expires (T32 sweep, no actor) | the player | `booking.expired` |
| Player cancels | the venue's current owners | `booking.cancelled` (owner wording) |
| The venue cancels (T40a) | the player | `booking.cancelled` (player wording, with the reason) |
| Owner records the arrival payment (T31) | the player | `payment.recorded` |
| A confirmed booking starts within the hour (T44) | the player | `booking.reminder` |
| Owner entries, walk-ins, check-in, no-show, complete | nobody | — |

Rentals and open-play groups behave the same. The actor never hears about their own action (an owner who
books their own venue is not told about it; a co-owner is). A row is written only for a recipient with an
active device, no account deletion in progress and the notification's topic switched on (see
[Alert preferences](#alert-preferences-t45)). A notification never blocks a booking: a recipient deleted
at the same moment is skipped.

The payload is fixed booking facts at event time: `audience`, `booking_kind` (`rental`/`group`),
`booking_id`, `venue_id`, `venue_name`, `starts_at` (UTC), for payments `amount_centavos` and, for a
venue cancellation (T40a, player audience only), its fixed `reason` (see docs/venue-cancellations.md). No
participant names, phone numbers or emails. The worker builds the lock-screen text with
`notificationMessage()` in `packages/domain/src/notification.ts` (Manila time, PHP amounts). Each push
carries `data = {notification_id, kind, audience, booking_kind, booking_id, venue_id, starts_at, recipient}`
(`pushDataFor()`), where `recipient` is the account UUID the row was written for, so the app can tell
whether the signed-in account may open it (see [Opening a push](#opening-a-push-t44)).

## One-hour reminders (T44)

`private.booking_reminders_enqueue(at_time, batch)` finds **confirmed player** rentals and open-play groups
whose start is in `(at_time, at_time + 1 hour]` and records one `private.booking_reminders` row per booking
(unique per rental or group booking), then an outbox row (`source = 'reminder'`, `event_id` = the reminder
id, kind `booking.reminder`, player audience, the same payload shape) for a player with an active device.
Pending, declined, cancelled and expired bookings, owner entries and walk-ins are never reminded; a booking
confirmed inside the hour is reminded on the next sweep. The decision is recorded even when the player has
no device, so each booking is decided once; concurrent sweeps insert each reminder once. Reminders older
than two days are pruned (bounded).

The every-minute `push-dispatch` cron hook (`private.push_dispatch_kick`) runs the sweep with the clock
before checking for due work, so reminders need no extra job: latency is up to about a minute, and a booking
confirmed with less than a minute to go can miss its reminder. When `push_outbox_claim` leases a reminder row
it re-checks the booking (`private.booking_reminder_due`): if it is no longer confirmed or has started, the
row is dropped as `obsolete` and never sent. A cancellation in the seconds between a claim and Expo's
acceptance can still deliver it; the booking screen says what is true. Owners get no reminders.

## Opening a push (T44)

`NotificationLinks` (root layout, inside Owner mode) listens for taps (`addNotificationResponseReceivedListener`,
plus the response that launched the app, cleared once read) and parses `data` with the strict
`readPushData()`: unknown kinds, a kind the audience never receives or a malformed ID is ignored; keys the
push service adds are ignored. Each notification is taken once. `links.ts` then decides:

| Push | Opens |
| --- | --- |
| Player alert or reminder | `/rental/booking/[id]` or `/play/booking/[id]` |
| Owner `booking.requested` | `/owner/requests/[venue]` |
| Owner `booking.created` / `booking.cancelled` | `/owner/desk/[venue]?date=<Manila day of the booking>` |

It opens **only when the signed-in account is the push's `recipient`**. Another account sees "This alert is
for another account" and nothing opens. A signed-out phone goes to Account to sign in and keeps the link for
10 minutes, then opens it if the right account signed in. Owner links wait for Owner mode's venue check,
switch to Owner mode and open; with no managed venue, or when the check fails, a notice explains why
instead. The screens and server reads still enforce access (a venue the owner no longer manages is refused
there). URL deep links (`picklyph://…`) go through the same route gates.

## Alert preferences (T45)

Each account has five switches, all on until changed. Every (audience, kind) pair belongs to exactly one
topic (`notificationTopic()` in the domain package, `private.notification_topic()` on the server):

| Topic | Audience | Kinds |
| --- | --- | --- |
| `requests` | owner | `booking.requested` (needs an answer) |
| `bookings` | owner | `booking.created`, `booking.cancelled` |
| `updates` | player | `booking.accepted`, `booking.declined`, `booking.expired`, `booking.cancelled` |
| `payments` | player | `payment.recorded` |
| `reminders` | player | `booking.reminder` |

`private.notification_preferences` keeps the muted topics per account (sorted, distinct; no row means
nothing muted). `notification_enqueue` skips a recipient who muted the row's topic, so a co-owner who kept
the topic still gets theirs. The switches are **account-wide** (every phone of the account follows them)
and apply to rows written after the change; a row already queued still goes out. The T44 sweep records its
decision before the outbox check, so a muted reminder is decided once and unmuting never resends it.

Service-only `notification_preferences_read(actor)` and `notification_preferences_save(actor, {muted})`
(the whole set is replaced, so retries and late duplicates land on the same answer). Unknown topics,
duplicates and other keys are `invalid_request`. The T47 insert trigger refuses a save once account
deletion has started (it runs before the upsert's conflict check, so it covers changes too), and the row
goes with the Auth user.

## Device registration

`POST /functions/v1/push-devices` with the signed-in bearer (verified through GoTrue) and one of:

```json
{ "kind": "register", "token": "ExponentPushToken[…]", "platform": "ios" }
{ "kind": "unregister", "token": "ExponentPushToken[…]" }
{ "kind": "preferences", "muted": ["reminders"] }
```

`GET /functions/v1/push-devices?section=preferences` reads the switches. Replies: `200
{"status":"registered"}`, `{"status":"removed"}` or `{"muted":[…]}`; `400 invalid_request` (also any other
query, or a GET without it); `401` `sign_in_required`/`invalid_auth`; `403 account_deleted`; `405` (only
GET and POST); `413` (1 KiB body cap); `415`; `429`; `503`. The body never names an account. Preferences
use the `push-preferences` bucket (30/min per user, continues in a Redis outage: self-only, no inventory).
Service-only `push_device_register(actor, input)`:

- idempotent: the same token again refreshes `seen_at` and re-enables a disabled token;
- a token registered from another account **moves** (new row, so the old account's deliveries never follow it);
- an account keeps its **10** most recently seen devices;
- account lock, then token lock (advisory), so the cap and moves serialize;
- refused once account deletion has started (T47 insert trigger plus an explicit check for refreshes).

`push_device_unregister` removes the token from the caller's own account only and answers the same either
way. Rate bucket `push-register`: 10/min per user and **continues in a Redis outage**, because registration
is idempotent, capped per account and creates no inventory.

## Worker

`POST /functions/v1/push-dispatch` accepts only `Authorization: Bearer <PUSH_WORKER_SECRET>` (at least 32
characters, compared by digest); user tokens get 401, a missing secret 503 `not_configured`. Each run:

1. `push_outbox_claim(25, 120)` leases due rows (pending and due, or sending with an expired lease) with
   `FOR UPDATE SKIP LOCKED`, so concurrent runs get disjoint rows, and returns each with the recipient's
   active devices that have **no ticket yet** for it. Rows older than 6 hours are dropped as `stale`; rows
   with nothing left to send finish (`sent`, or `dropped`/`no_devices`). Finished rows and disabled devices
   older than 30 days are deleted here (bounded).
2. Messages go to Expo in chunks of 100. A run stops starting Expo calls after 20 s, well inside the
   120 s lease; unsent devices are retried by a later run.
3. `push_outbox_complete` applies outcomes only for a row the caller still holds (same `claim_id`, still
   `sending`); a reply from an expired lease is counted `stale` and changes nothing. `ok` records the
   ticket (unique per row and device), `DeviceNotRegistered` disables the token, `retry` backs off 30 s
   doubling to 15 min (or Expo's `Retry-After`, up to 1 h) for at most **5 attempts**, then `failed`
   (`retries_exhausted`). `MessageTooBig`, `InvalidCredentials` and `MismatchSenderId` fail the row with
   their code. The whole batch is validated before anything changes.
4. `push_receipts_due` returns tickets sent at least 15 minutes ago (tickets older than 24 hours are marked
   `unknown`; Expo no longer has them); `push_receipts_record` stores each receipt once, and a
   `DeviceNotRegistered` receipt disables the token. The app registering the token again re-enables it.

**Delivery guarantee.** Each row is created once and each (row, device) gets at most one recorded ticket.
Expo has no idempotency key, so one duplicate is possible only if a run loses its completion reply after
Expo accepted the messages *and* the lease then expires (the worker retries the completion once first).

**Scheduling.** `private.push_dispatch_schedule()` creates the every-minute pg_cron job
`push-dispatch`, which runs `private.push_dispatch_kick()`. The kick returns without a call when nothing is
due, and otherwise calls the function with pg_net, reading `push_dispatch_url` and `push_worker_secret`
from Vault (`not_configured` if either is missing). Latency is therefore up to about a minute.

## Mobile

- `expo-notifications` 57.0.22 and its config plugin (iOS push entitlement). **The installed development
  build lacks it:** the app loads the module lazily, so older builds keep working and the Account row reads
  "Not available in this version of the app".
- `PushRegistration` (root layout) registers the phone for the signed-in account on sign-in, on return to
  the app and when iOS issues a new token. It never shows the permission prompt. One registration per
  backend, account and token per app run.
- Account → Settings → **Booking alerts** shows the state and opens `/notifications` (T45): **This phone**
  explains alerts before the iOS prompt (the prompt appears only after **Turn on booking alerts**), sends a
  denied phone to iPhone Settings instead of asking again, and says booking works the same without alerts;
  **What to send** holds the account's switches (owner topics appear when the account manages a venue or
  has muted one). Switch changes go out one at a time and only the newest waiting set follows; a failure
  puts the switches back to the last saved set.
- `AlertsNudge` on player booking detail (pending or confirmed rentals and groups) and owner Booking
  requests: the same explanation and **Turn on alerts**, only while iOS has never asked. **Not now** hides it
  on this phone (`pickly.alerts.nudge.v1`). Denied, unavailable or on: nothing shows. Booking screens never
  depend on alerts.
- While the app is open, pushes show as a banner and in the list, without sound or badge, and **only when
  their `recipient` is the signed-in account** (`shouldPresent`). Tapping one opens the booking (see above).
- **Sign-out** (`useAlertSignOut`) first holds registration for the account (a foreground return cannot
  re-register it), waits for a registration already in flight, and removes this phone's token while the
  session still exists. If that cannot be confirmed (offline, rate limited), the person chooses **Try
  again**, **Sign out anyway** or **Stay signed in**. After "sign out anyway" the account keeps the token
  until the next sign-in on the phone moves it (registration moves tokens between accounts); there is no
  unauthenticated release. Without permission (or in a build without push) there is nothing to remove.
- Account deletion removes devices, rows and preferences through the Auth cascade.

## Rollout and operator steps

1. `supabase db push` for `20261010090000_push_notifications.sql`, `20261010120000_booking_reminders.sql`
   and `20261010150000_notification_preferences.sql` (T44 and T45 need no other operator step: the
   push-dispatch job sweeps reminders, and preferences are read inside the outbox write).
2. Deploy `push-devices` and `push-dispatch` (both `verify_jwt = false` with the import map in
   `config.toml`; they reuse `DISCOVERY_SUPABASE_*`, `PICKLY_ENV` and the Upstash secrets).
3. Set the function secret `PUSH_WORKER_SECRET` (a random value of at least 32 characters). Optionally set
   `EXPO_ACCESS_TOKEN` if Expo enhanced push security is turned on for the project.
4. Enable the `pg_net` extension. Store the same worker secret and the function URL in Vault, by name only:
   `select vault.create_secret('<function URL>', 'push_dispatch_url');` and
   `select vault.create_secret('<worker secret>', 'push_worker_secret');`. Then run
   `select private.push_dispatch_schedule();` (pg_cron is already enabled on staging).
5. Build a new EAS development binary: the push capability is synced by EAS, and Expo needs an APNs key
   (`eas credentials`). H10 then checks delivery, permission denial and background behaviour on the iPhone,
   plus T45: Booking alerts explains before iOS asks; after a denial it offers Settings and booking still
   works; a muted topic stops that alert on every phone of the account; the nudge shows once per phone and
   **Not now** hides it; signing out with alerts on stops that account's pushes on the phone (and offline
   asks first); another account's push never shows while the app is open.

## Tests

- `npm run test:notifications`: the rollback-only PGlite suites (`supabase/tests/notifications.sql` with
  24 function mutations and 2 dropped triggers; `reminders.sql` with 16 mutations: window boundaries to the
  millisecond, statuses and sources, the claim-time re-check, recipients in claims, the cron hook, pruning;
  `alert-preferences.sql` with 14 mutations and the dropped deletion guard: the topic map, strict saves,
  muted owners/co-owners/players/reminders/payments, deletion and cascade), push handler/Expo/worker tests
  and the mobile client tests (preferences, the one-at-a-time writer, sign-out release and its races, the
  in-app recipient filter, the nudge) and link tests.
- `npm run test:notifications:local`: Docker SQL suite; real GoTrue/PostgREST registration through the
  shipped client (forged JWT, direct RPC denial, racing registrations of one token, the device cap, Redis
  outage); real booking commands; two concurrent workers against a fake Expo server (each row and device
  once); Expo outage and `Retry-After`; `DeviceNotRegistered` from tickets and receipts; a dead worker's
  expired lease; T44 reminders on the real clock (six concurrent sweeps, a cancelled and a pending rental, an
  acceptance inside the hour, a cancellation after the reminder, the sent data read by the shipped link
  logic); the cron hook and schedule; T45 preferences through the shipped client (racing saves, direct RPC
  denial, muted co-owner and player, deletion refusal) and sign-out release (offline failure keeps the
  token, retry removes it, the player's next alert is not queued); served Edge auth and preference checks
  with nothing due. It never calls the real Expo service. Run it alone: it replaces any running
  `functions serve` container.
