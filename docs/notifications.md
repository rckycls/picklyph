# Booking notifications (T43)

Push is supplementary: the booking screens stay the source of truth. T43 adds push device registration, a
transactional outbox fed by booking events, and a worker that delivers through the Expo push service.
Reminders and deep links are T44; per-kind preferences, a pre-permission explanation and sign-out
unregistration are T45.

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
| Anyone else cancels (future T40a) | the player | `booking.cancelled` (player wording) |
| Owner records the arrival payment (T31) | the player | `payment.recorded` |
| Owner entries, walk-ins, check-in, no-show, complete | nobody | — |

Rentals and open-play groups behave the same. The actor never hears about their own action (an owner who
books their own venue is not told about it; a co-owner is). A row is written only for a recipient with an
active device and no account deletion in progress. A notification never blocks a booking: a recipient
deleted at the same moment is skipped.

The payload is fixed booking facts at event time: `audience`, `booking_kind` (`rental`/`group`),
`booking_id`, `venue_id`, `venue_name`, `starts_at` (UTC) and, for payments, `amount_centavos`. No
participant names, phone numbers or emails. The worker builds the lock-screen text with
`notificationMessage()` in `packages/domain/src/notification.ts` (Manila time, PHP amounts). Each push
carries `data = {notification_id, kind, audience, booking_kind, booking_id}` for T44 routing.

## Device registration

`POST /functions/v1/push-devices` with the signed-in bearer (verified through GoTrue) and one of:

```json
{ "kind": "register", "token": "ExponentPushToken[…]", "platform": "ios" }
{ "kind": "unregister", "token": "ExponentPushToken[…]" }
```

Replies: `200 {"status":"registered"}` or `{"status":"removed"}`; `400 invalid_request`; `401`
`sign_in_required`/`invalid_auth`; `403 account_deleted`; `405`; `413` (1 KiB body cap); `415`; `429`;
`503`. The body never names an account. Service-only `push_device_register(actor, input)`:

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
- Account → Settings → **Booking alerts**: shows the state; a tap asks for permission the first time, opens
  iOS Settings when denied, or retries a failed registration.
- While the app is open, pushes show as a banner and in the list, without sound or badge.
- Sign-out does not unregister yet (T45). Account deletion removes devices and rows through the Auth cascade.

## Rollout and operator steps

1. `supabase db push` for `20261010090000_push_notifications.sql`.
2. Deploy `push-devices` and `push-dispatch` (both `verify_jwt = false` with the import map in
   `config.toml`; they reuse `DISCOVERY_SUPABASE_*`, `PICKLY_ENV` and the Upstash secrets).
3. Set the function secret `PUSH_WORKER_SECRET` (a random value of at least 32 characters). Optionally set
   `EXPO_ACCESS_TOKEN` if Expo enhanced push security is turned on for the project.
4. Enable the `pg_net` extension. Store the same worker secret and the function URL in Vault, by name only:
   `select vault.create_secret('<function URL>', 'push_dispatch_url');` and
   `select vault.create_secret('<worker secret>', 'push_worker_secret');`. Then run
   `select private.push_dispatch_schedule();` (pg_cron is already enabled on staging).
5. Build a new EAS development binary: the push capability is synced by EAS, and Expo needs an APNs key
   (`eas credentials`). H10 then checks delivery, permission denial and background behaviour on the iPhone.

## Tests

- `npm run test:notifications`: the rollback-only PGlite suite (`supabase/tests/notifications.sql`) with
  24 function mutations and 2 dropped triggers, push handler/Expo/worker tests and the mobile client tests.
- `npm run test:notifications:local`: Docker SQL suite; real GoTrue/PostgREST registration through the
  shipped client (forged JWT, direct RPC denial, racing registrations of one token, the device cap, Redis
  outage); real booking commands; two concurrent workers against a fake Expo server (each row and device
  once); Expo outage and `Retry-After`; `DeviceNotRegistered` from tickets and receipts; a dead worker's
  expired lease; the cron hook and schedule; served Edge auth checks with nothing due. It never calls the
  real Expo service. Run it alone: it replaces any running `functions serve` container.
