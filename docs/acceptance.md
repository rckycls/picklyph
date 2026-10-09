# Pilot acceptance (T48)

One local run walks the pilot journey across the real pieces together, on fresh accounts, and checks access isolation at every step. It adds no product code: it drives what already ships. Physical iPhone acceptance stays manual (walkthrough below).

```bash
npm run test:acceptance:local
```

## What runs, and where

| Piece | How the run uses it |
| --- | --- |
| Local Supabase (Docker) | Real Auth, PostgREST, Storage and PostgreSQL with every migration; trusted SQL only for the bootstrap admin/moderator roles and a second owner's published listing |
| Production admin console | `next start` on `127.0.0.1:3100` from the existing build; admin, moderator and a player sign in with real email codes from Mailpit |
| Served Edge | `supabase functions serve` (every function) with **Redis absent**: guest discovery, cancellations, reads and account deletion, which keep working in an outage, and one new hold, which must fail closed |
| Node-hosted Edge handlers | The shipped `owner-submissions`, `owner-venues`, `owner-schedules`, `owner-sessions`, `rental-bookings`, `session-bookings` and `venue-reports` handlers with their real Supabase deps and the real `createRateGuard` over an in-memory limiter. Creation needs an enforced allowance, and the Edge guard only accepts a real `*.upstash.io` endpoint, so creation runs here |
| Shipped mobile clients | `searchClient`, `venueDetail`, `ownerClient`, `venueClient`, `calendarClient`, `sessionClient`, `deskClient`, `rental/client`, `openPlay/client`, `reportClient` and `deletionClient` (plus the rental/open-play models), exactly as the app calls them |

Accounts: **Olivia** (adds a venue), **Rex** (owns a different published listing), players **Pia** and **Paolo**, an **admin** and a **moderator**. Listings sit in a random Sulu Sea area so discovery and duplicate checks only meet this run's own data.

## Scenarios

| # | Scenario | What must hold |
| --- | --- | --- |
| 1 | Guest discovery | Served `venue-search` (no Authorization) returns only the published listing; public detail lists its courts |
| 2 | Owner adds a venue | The submission (with a proof photo) creates a private `draft/pending` listing: no public read, no search result, `pending_venue_ids` only. Rex and Paolo cannot open it or set its hours/policy. Olivia names the courts, sets 06:00–22:00 hours with two rate bands and an approval policy. Nobody can quote it and Olivia cannot schedule sessions before review |
| 3 | Console review | Guests are sent to sign-in (decision 401); players see "Reviewer access required." (403); the moderator sees the venue but cannot publish (403, still a draft); the admin's **Approve and publish** makes it `approved/verified` and Olivia its owner |
| 4 | Discovery after publication | Guests find both listings; the new one shows `verified` and two courts |
| 5 | Approval rental | Pia's 90-minute quote is PHP 600 (90 minutes at PHP 400/hour); her request is a pending hold; Paolo's overlapping request gets `allocation_conflict`. Rex, Paolo, the moderator and the admin get `not_owner` for the request queue and acceptance; Olivia sees exactly Pia's request and accepts it. Paolo gets `not_owner` reading Pia's booking. Olivia's calendar shows the rental; Rex cannot read it |
| 6 | Instant open play | Policy switched to instant. Rex cannot schedule on Olivia's venue. A 4-spot session with a group limit of 2 at PHP 250/person: Pia's two names confirm at PHP 500; the app's preview refuses three names and the server answers `group_limit_exceeded`; Paolo's pair fills the session; Rex gets `session_full`; Pia gets `not_owner` reading Paolo's group |
| 7 | Cancellation, Redis absent | Over served Edge, Pia cancels her rental (a retry returns `existing`) and Paolo cancels his group; spots return. Paolo's new request over served Edge is `unavailable` (503) and writes nothing; the same request through the guarded handler confirms on the released court |
| 8 | Report and moderation | Paolo reports the listing. Players are refused the reports page and decisions; the moderator reads the report and suspends: the listing leaves discovery, quotes and new groups get `venue_unavailable`, existing rentals and groups stay readable. The admin reinstates it |
| 9 | Direct API isolation | Every single-overload `public` function that neither `anon` nor `authenticated` may execute (50 today, including all booking, review, moderation and deletion commands) returns `42501` for anon and all six signed-in accounts; the private schema and direct listing/court writes are denied; `my_account_access` matches each role; a forged token gets 401 from all seven handlers before the guard; every guarded command carried a verified user principal with the expected action (`owner-submit`, `owner-edit`, `hold-create`, `report-create`) |
| 10 | Account deletion | Pia deletes her account over served Edge: the Auth user is gone, her upcoming group is cancelled with names "Guest 1/2" and spots released; Paolo's rental and the venue are untouched; her old token gets 401 |

Cleanup removes the run's accounts (cascading profiles and submissions), venues (cascading courts, inventory, sessions, groups and reports), evidence objects, audit and deletion rows, and Mailpit messages, then compares IDs/counts with the state before the run.

## Notes from the run

- A player reading another player's rental or group gets **403 `not_owner`**, not 404. That is the documented contract ("wrong player/owner 403" in `rental-bookings.md`, `session-bookings.md`); booking IDs are random UUIDs.
- Admin and moderator roles grant nothing in the booking APIs: they get `not_owner` like any other non-owner.
- Run it alone. It serves every Edge function (replacing a running `functions serve` container) and binds port 3100. It does not touch Metro (8081) or `admin:dev` (3000). About 40 seconds.
- Prerequisites: the local Supabase stack running with all migrations, and a current `npm run admin:build`. No Redis, Google key or hosted access is needed.
- Not covered here (owned by their tasks): front-desk records and timing boundaries (T31, T33), scheduled expiry (T32), payments and refunds (W11–W13), notifications (W14) and hosted rollout (T50).

## Manual iPhone walkthrough (pilot)

Device checks happen only on the physical iPhone with the EAS development build; there are no web previews. On staging this needs the T27–T31, T32, T46 and T47 migrations and the `owner-venues`, `owner-schedules`, `rental-bookings`, `owner-sessions`, `session-bookings`, `venue-reports` and `account-deletion` functions (see `vibe-plus/HANDOFF.md`). Use two accounts on the phone, signing out between them, and the console on a laptop.

1. Signed out, open Discover: published venues show; your new venue does not yet.
2. Account A, Owner mode → **Add your venue**: pin, details, proof photo. Then **Set up your venue**: rename courts, set hours and rates, choose approval in Policies.
3. Console (admin): **Approve and publish**. Back on the phone, signed out, the venue appears on Discover with its courts.
4. Account B: book a court on it. The booking shows "Awaiting approval".
5. Account A: Your venues → **Booking requests** → accept. Account B sees "Confirmed".
6. Account A: switch the policy to instant and schedule an open-play session (group limit 2). Account B joins with two names; a third name is refused with the group-limit message.
7. Account B: cancel the rental and the group from Bookings; the session shows its spots again.
8. Account B: Discover → the venue → **Report a problem with this listing**. Console (moderator): suspend it; it leaves Discover. Console (admin): reinstate it.
9. Account B: join the session again, then Account → **Delete account**, type DELETE. The app signs out, and Account A's session shows those spots free again.

Report anything that differs, with the step number.
