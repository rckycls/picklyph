# Venue cancellations (T40a)

A current owner of a venue can cancel a future confirmed player booking (a court rental or an open-play group) for one fixed reason, or cancel a whole open-play session together with every group and walk-in in it. Inventory is released in the same transaction, the player gets one push with the reason, and each cancellation keeps an immutable audit row. **No money moves:** the pilot is pay-on-arrival only, arrival payments are recorded only from a booking's start (T31), and venue cancellation closes at the start, so a cancelled booking never has a collected payment and nothing is refunded. Online refunds stay with the future T40.

## Rules

- **Reasons** (fixed, `packages/domain/src/cancellation.ts`): `weather`, `maintenance`, `venue_closed`, `schedule_conflict`, `player_request`, `other`. Owners pick from labels; players read a phrase ("because of the weather", "at your request"; `other` adds nothing).
- **Who:** a current owner link on a verified listing (`private.rental_require_owner`), also while a moderation suspension is in force. Players, other owners, admins and moderators get `not_owner`. A revoked owner loses it at once.
- **What:** confirmed **player** rentals and groups only. Pending requests are declined instead; owner entries and walk-ins keep their existing removal (`cancel`); declined, expired and player-cancelled bookings answer `invalid_transition`.
- **When:** before the booking's start by the database clock; at or after the start → `invalid_transition` (sessions: `session_started`).
- **Front-desk records:** a booking with an attendance or payment record answers `payment_collected` (sessions: when any confirmed booking has one). This is unreachable today because of the start gate; it guards any later change and never implies a refund.
- **Retries:** the first venue cancellation stands. A retry, a racing co-owner or a later booking-level call after a session cancellation returns `existing` with the stored reason; one event and one audit row exist.
- **Sessions:** without a reason, a session with spots taken is still refused with `session_has_bookings` (so clients and functions from before T40a keep their answer); an empty session cancels with or without a reason. With a reason, every pending and confirmed group and walk-in is cancelled (one `cancel` event and one audit row each, all naming the session), every court is released, the counter is zeroed and the session records `cancel_reason` and `cancelled_by`.

## Contracts

- `rental-bookings` and `session-bookings`: `POST {kind:"venue_cancel", booking_id, reason}` → `{outcome:"changed"|"existing", booking}`. Booking reads now include `venue_cancellation: null | {reason, cancelled_at}` (non-null only for venue-cancelled bookings; the parsers accept older replies without the key).
- `owner-sessions`: `POST {kind:"cancel", session_id[, reason]}` → `{outcome:"cancelled"|"existing", session}`; sessions include `cancel_reason`.
- Errors: `invalid_input`/`invalid_request` 400, `not_owner` 403, `booking_not_found`/`session_not_found` 404, `invalid_transition`, `payment_collected`, `session_has_bookings`, `session_started` 409. Bodies are strict; no actor, refund or notification field is accepted.
- Rate limiting: venue cancellations use the `cancel` bucket, which **continues in a Redis outage**, like player cancellations.
- Service-only RPCs: `owner_booking_cancel(actor, kind 'rental'|'session', booking, reason)` and `owner_session_cancel(actor, session, reason default null)` (the T27 two-argument signature was replaced).

## Storage, audit and locks

Migration `20261011090000_venue_cancellations.sql`: private `booking_cancellations` (one row per venue-cancelled booking: venue, actor UUID, reason, time, causing session; no API grants; updates refused by trigger; cascades with the booking or venue), session `cancel_reason`/`cancelled_by` (protected by the session immutability trigger once cancelled; null while scheduled). The audit row is written before the booking event, inside the same transaction, so an event or audit failure rolls the whole cancellation back. Lock orders match the existing commands: rentals venue (share) → owner link → court → allocation → booking; groups venue → owner link → session → booking; sessions venue → owner link → courts (UUID order) → session → live bookings (UUID order). A session cancellation also records the T27 `session.cancel` directory audit event.

## Notifications

Each cancel event goes through the T43 trigger: the actor is an owner, so the player hears `booking.cancelled` under the `updates` topic, with `reason` in the payload (player audience only). Walk-ins and owner entries notify nobody. Pending one-hour reminders for the booking become obsolete at claim time (T44). Lock-screen text: "<Venue> cancelled your court rental for <Manila time> because of the weather."

## App

- **Front desk** (`FrontDesk.tsx`): in a booking's sheet, **Cancel booking** appears for confirmed player bookings before the start with no desk records (`canVenueCancel`). The owner picks a reason, confirms, and the sheet closes on success. A lost reply is resolved by repeating the same request (`venueCancel` in `deskClient.ts`).
- **Open-play sessions** (`SessionScheduler.tsx`): **Cancel session** for any scheduled future session; an occupied one asks for a reason and warns how many spots are booked. Cancelled sessions show their reason.
- **Players**: rental and group detail and history read "Cancelled by the venue" with the reason and "Nothing was charged".

## Rollout

**Staging (2026-10-11):** step 1 done in that order (`push-dispatch` deployed, migration applied, the three booking functions redeployed). Player alerts for venue cancellations wait for the push worker setup in docs/notifications.md.

1. Deploy `push-dispatch` first (its payload parser now accepts `reason`; the old one would drop such rows), then `supabase db push` for `20261011090000_venue_cancellations.sql`, then redeploy `rental-bookings`, `session-bookings` and `owner-sessions`. Until the three are redeployed, the new commands are simply unavailable; existing calls keep working.
2. Reload Metro; no native module or new EAS build is needed beyond T43's push build.
3. iPhone checks (H08/H10): cancel a rental and a group from the front desk with each kind of reason; cancel an occupied session; confirm the player's detail, history and push text; confirm the slot is bookable again; check large text and VoiceOver on the reason chips.

## Tests

- `npm run test:cancellations`: the rollback-only PGlite suite `supabase/tests/venue-cancellations.sql` (access, transitions, records, retries, released inventory, audit, alerts with the reason, whole sessions, suspension, revocation, event rollback, immutability, API-role denial) with 21 function mutations and a dropped trigger caught, plus handler/deps tests for the three functions.
- `npm run test:cancellations:local`: the Docker SQL suite; real Auth/PostgREST through the Node handlers (six racing owner cancellations with different reasons, owner-versus-player races, observed lock orders both ways, revocation-first, six racing session cancellations, request-first and session-first); the shipped desk, session and player clients with one lost committed reply; served Edge without Redis. Run it alone: it replaces any running `functions serve` container.
