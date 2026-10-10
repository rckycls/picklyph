# Privacy and account deletion (T47)

Signed-in users delete their own account in the app: **Account → Delete account**, type `DELETE`, confirm (and confirm with Apple, for accounts that sign in with Apple). The server revokes the app's Apple tokens (T50a), cancels their upcoming bookings under the normal player-cancel rule, releases any venues they manage, retires drafts still in review, erases their names, photos, evidence and profile, and keeps only UUID-level booking and audit references that venues need for reconciliation. The phone then forgets every account-scoped recovery request and signs out.

## The deletion flow

`POST /functions/v1/account-deletion` with exactly `{"confirm":"delete_account"}` and the user's bearer (no actor field is accepted). An account that signs in with Apple also sends `apple_authorization_code` (T50a, below).

1. Auth verifies the bearer; the account-delete limit applies (5 per minute per user). Like cancellation, deletion **keeps working when Redis is down**.
2. Apple-linked accounts only: the Apple code is exchanged and its Apple ID checked (below). Nothing has changed yet.
3. `account_deletion_begin(actor)` runs in one transaction (next section). Console accounts are refused here with `403 privileged_account`.
4. Apple-linked accounts only: the app's Apple tokens are revoked.
5. The function empties `avatars/<id>/` and `owner-evidence/<id>/` through the Storage API (this also removes uploads whose commit was uncertain).
6. `auth.admin.deleteUser(id)` deletes the Auth user; its cascades remove the rest (below).
7. `200 {"status":"deleted"}`.

Any failure before step 6 answers `503` with `Retry-After`. A retry resumes, because `account_deletion_begin` is retry-safe, and the Auth user is never deleted while its files remain. If the reply to a finished deletion is lost, the retry's token has outlived the account. Auth checks the token's signature and then answers `user_not_found`, and the function confirms `deleted` only when `account_deletion_status` says the deletion started here (otherwise `401`).

| Reply | Meaning |
| --- | --- |
| 200 `{"status":"deleted"}` | Deleted (also returned to a confirmed retry) |
| 400 / 413 / 415 / 405 | Wrong body or query, too large, not JSON, not POST |
| 401 | No valid bearer, or a missing account with no deletion record |
| 403 `privileged_account` | The account holds an admin or moderator role |
| 409 `apple_reauthorization_required` / 403 `apple_account_mismatch` | Apple-linked account: no usable Apple code, or a code for another Apple ID (T50a). Nothing changed. |
| 429 | Limit reached (`Retry-After`) |
| 503 | Auth, database, Storage, Auth-admin or Apple trouble; retry is safe |
| 503 `apple_unavailable` | Apple-linked account, but the function has no Apple secrets (no `Retry-After`) |

On the phone, only a confirmed deletion clears device data: `src/lib/recoveryKeys.ts` removes the five recovery journals (`rental-attempt`, `group-attempt`, `session-attempt`, `walk-in-attempt`, `owner-entry-attempt`) under both namespace forms, then signs out locally. Ordinary sign-out still keeps them. Device preferences (Discover view, welcome screen) aren't account data and stay.

## Sign in with Apple revocation (T50a)

Apple requires apps that offer Sign in with Apple to revoke the user's Apple tokens when the account is deleted. Supabase Auth keeps no Apple tokens, so the phone gets a fresh authorization for this one request.

- **Phone.** For an account that signs in with Apple (an `apple` identity or provider on the session user), Delete account adds a line about Apple, and the button reads **Continue with Apple and delete**. Apple's sheet opens only after `DELETE` is typed and the button is tapped. Closing it, or an Apple error, sends nothing. The single-use code goes into that request body only; it is never saved, journaled or logged. If the server still answers 409 (it knows an Apple identity the phone didn't, or Apple refused the code), the phone asks Apple once more in the same tap, never a third time.
- **Server.** The account's Apple IDs come from the verified Auth user (GoTrue identity provider IDs), never the request. An account without one ignores a code and never calls Apple. Before any deletion work, the code is exchanged at `appleid.apple.com/auth/token` with an ES256 client secret: key ID, team ID, `client_id` = bundle ID, Apple's audience, a five-minute life, signed fresh for each call. The returned ID token's issuer, audience and subject are checked. It comes straight from Apple's token endpoint over TLS, so its signature isn't checked separately (OIDC Core 3.1.3.7). A refused code (`invalid_grant`: invalid, expired or used) answers 409, and a different Apple ID answers 403. After `account_deletion_begin`, the refresh token (or, failing that, the access token) is revoked at `/auth/revoke`, before the storage folders and the Auth user are removed.
- **Failures.** Apple trouble answers 503 with `Retry-After`. If the revocation fails after begin, the deletion is `pending`, and the Auth user and files stay. The next tap's old code is spent, so it gets a 409, Apple again, then finishes. Without all four Apple secrets (`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_CLIENT_ID`, `APPLE_PRIVATE_KEY`), Apple-linked accounts get `503 apple_unavailable` before anything changes (fail closed). A retry after a lost reply to a finished deletion is confirmed from the deletion record, without Apple.
- **Not covered:** stored Apple refresh tokens, revocation at sign-out, and Apple's server-to-server notifications (a person stops using their Apple ID with pickly, or deletes their Apple account).

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
- **Apple revocation (T50a), local only so far.** Set the four Apple secrets on the project (docs/auth-setup.md#apple-token-revocation-key-t50a), then redeploy `account-deletion`; until then, Apple-linked accounts get `503 apple_unavailable`. No migration, and no native build (`expo-apple-authentication` is already in the app); reload Metro.
- iPhone check (signed-in test account with a booking): Account → Delete account; read the list; the button stays disabled until `DELETE` is typed; delete; the done screen appears and Account shows the guest view; Bookings asks you to sign in; a console account sees the role message. Check VoiceOver and large text on the list. With an Apple-signed-in account, the extra line and **Continue with Apple and delete** appear. Closing Apple's sheet shows "Nothing was deleted…". Confirming deletes the account, and pickly is gone from Sign in with Apple in the iPhone's Apple ID settings.
- Not covered: data export, an admin console deletion tool, an evidence purge job, an end date for booking records.
