# Privacy and account deletion (T47)

Signed-in users delete their own account in the app: **Account → Delete account**, type `DELETE`, confirm. The server cancels their upcoming bookings under the normal player-cancel rule, releases any venues they manage, retires drafts still in review, erases their names, photos, evidence and profile, and keeps only UUID-level booking and audit references that venues need for reconciliation. The phone then forgets every account-scoped recovery request and signs out.

## The deletion flow

`POST /functions/v1/account-deletion` with exactly `{"confirm":"delete_account"}` and the user's bearer (no actor field is accepted).

1. Auth verifies the bearer; the account-delete limit applies (5 per minute per user). Like cancellation, deletion **keeps working when Redis is down**.
2. `account_deletion_begin(actor)` runs in one transaction (next section). Console accounts are refused here with `403 privileged_account`.
3. The function empties `avatars/<id>/` and `owner-evidence/<id>/` through the Storage API (this also removes uploads whose commit was uncertain).
4. `auth.admin.deleteUser(id)` deletes the Auth user; its cascades remove the rest (below).
5. `200 {"status":"deleted"}`.

Any failure before step 4 answers `503` with `Retry-After`. A retry resumes, because `account_deletion_begin` is retry-safe, and the Auth user is never deleted while its files remain. If the reply to a finished deletion is lost, the retry's token has outlived the account. Auth checks the token's signature and then answers `user_not_found`, and the function confirms `deleted` only when `account_deletion_status` says the deletion started here (otherwise `401`).

| Reply | Meaning |
| --- | --- |
| 200 `{"status":"deleted"}` | Deleted (also returned to a confirmed retry) |
| 400 / 413 / 415 / 405 | Wrong body or query, too large, not JSON, not POST |
| 401 | No valid bearer, or a missing account with no deletion record |
| 403 `privileged_account` | The account holds an admin or moderator role |
| 429 | Limit reached (`Retry-After`) |
| 503 | Auth, database, Storage or Auth-admin trouble; retry is safe |

On the phone, only a confirmed deletion clears device data: `src/lib/recoveryKeys.ts` removes the five recovery journals (`rental-attempt`, `group-attempt`, `session-attempt`, `walk-in-attempt`, `owner-entry-attempt`) under both namespace forms, then signs out locally. Ordinary sign-out still keeps them. Device preferences (Discover view, welcome screen) aren't account data and stay.

## What `account_deletion_begin` does

| Data | Outcome |
| --- | --- |
| Admin/moderator role | Refused before anything changes. Another admin removes the role first, so the console never loses its last admin to a self-deletion. |
| Owner links | Each one is revoked, like a T46 revocation: `owner.revoke` audit row with reason `owner_request`, where actor and subject are both the account. If no owner is left, the listing becomes unclaimed and stops taking new bookings. Existing player bookings stay; venue cancellation with refunds is T40. |
| Pending new-venue draft | Retired like a rejected submission (`draft`→`suspended`, `pending`→`unclaimed`, `directory.suspend` audit row). Reviewers then get `listing_unavailable`. |
| Upcoming player rentals and groups (pending or confirmed, not started) | Cancelled by the player's own `rental_booking_change` / `session_booking_change`, with events and released inventory. Started bookings stay. |
| Owner entries, walk-ins, blocks and sessions the account entered as an owner | Stay: they are the venue's records. |
| Names in the account's player groups (every status) | Replaced with `Guest 1`, `Guest 2`… in `participants` and `request_input`. The session-booking guard allows this one change, and only for an account whose deletion has started. |
| `private.account_deletions` | One row (UUID, time). Kept. |

**Concurrency.** Begin holds the profile row for update. Inserts into allocations, session bookings, sessions, owner links, roles, claims, submissions, reports and venue photos take the profile's key-share lock and are refused (`account_deleted`) once a deletion record exists. Ownership approval already holds the claimant's profile. So an insert that got there first is visible to begin, and a later one is refused. Both orders are proven with observed lock waits. A rare deadlock (the same player booking another slot on a court they hold while deleting) aborts one side, and that side is retried.

## What the Auth deletion removes

`profiles` (display, first and last name, phone, avatar path), console roles, remaining owner links, `venue_claims` and `venue_submissions` (their evidence objects are already gone). Reports keep their row with `reporter_user_id` set null.

## What is kept, and for how long

| Data | Kept as | Retention |
| --- | --- | --- |
| Rental and group bookings, snapshots, events, front-desk attendance/arrival-payment records | Venue, court, time, price, status, payment record; requester as a UUID with no profile | Kept for venue reconciliation and disputes. The production end date is an H11 decision. |
| Guest labels and walk-in names an owner entered | The venue's records | With the booking |
| Directory, ownership and moderation audit rows | UUIDs and fixed codes only, no FK | Kept |
| `requested_by` / `created_by` / `uploaded_by` UUIDs | UUID only | With the record |
| Venue photos the account uploaded | Venue content | With the listing |
| Open reports | Anonymous after deletion, so reviewers can still act | Until decided |
| Report free text | — | Cleared 180 days after the decision by `private.privacy_retention_sweep` (daily 03:17 Manila via pg_cron). Reason, status and dates stay. |
| Owner evidence (active accounts) | Private bucket, reviewer-only through the console route | Deleted with the account. A purge some days after a decision needs a storage worker (T51); not built. Photos keep their metadata until then. |

## Rollout and operator notes

- Local Docker only so far. Staging needs `supabase db push` (`20261009150000_account_deletion.sql`), then the `account-deletion` function deployed. It reuses the `DISCOVERY_SUPABASE_*` and Upstash secrets, and `config.toml` sets `verify_jwt = false` and the import map. Reload Metro; no native build.
- pg_cron: the migration schedules `privacy-retention-sweep` only if pg_cron is already enabled. Otherwise, after enabling it, run `select private.privacy_retention_schedule();` (idempotent).
- Deletions that started but didn't finish (the account can't add anything new until the user retries): `select user_id, requested_at from private.account_deletions d where exists (select 1 from auth.users u where u.id = d.user_id);`
- Deleting an account on someone's behalf (support): follow the same order with trusted access. Run `select public.account_deletion_begin('<id>');`, empty both storage folders, then delete the Auth user.
- **Apple token revocation is not built (deferred, user decision 2026-10-09).** Apple asks apps with Sign in with Apple to revoke the user's token on deletion. That needs a Sign in with Apple key (`.p8`, Key ID, Team ID) as server secrets, a fresh Apple sign-in on the device to get an authorization code, then `appleid.apple.com/auth/token` and `/auth/revoke`. It must be done before App Store review (T50/H11).
- iPhone check (signed-in test account with a booking): Account → Delete account; read the list; the button stays disabled until `DELETE` is typed; delete; the done screen appears and Account shows the guest view; Bookings asks you to sign in; a console account sees the role message. Check VoiceOver and large text on the list.
- Not covered: data export, an admin console deletion tool, Apple revocation, an evidence purge job, an end date for booking records.
