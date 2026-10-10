# Listing reports and moderation (T46)

Signed-in players report a published listing from the app. Administrators and moderators work a report queue in the console: they dismiss or resolve reports, suspend and reinstate listings, and remove owner links. Every change is a service-only database command that takes the server-verified actor, locks the actor's current role row until commit, and writes an audit row in the same transaction. No moderation path can grant ownership, roles, directory curation or booking/payment authority.

## Who can do what

| Action | Player | Owner (own listing) | Moderator | Admin |
| --- | --- | --- | --- | --- |
| Report a published listing | Yes | Yes | Yes | Yes |
| Read the report queue and a listing's reports/history | No | No | Yes | Yes |
| Dismiss / resolve reports, suspend, reinstate, remove an owner | No | No | Yes, except on listings they own, claimed or submitted (`self_moderation`) | Same |
| Link an owner | No | No | Only by approving a claim in the T17 review | Same, plus approving new venues |
| Grant roles, curate the directory, change payment settings, accept/cancel/record bookings | No | Owner commands only | **No** | Roles and directory only |

T08's unaudited `set_verified_venue_owner` is **dropped**. Owner links now come only from the audited T17 review (or trusted operator SQL), and removal goes through the audited `ownership_revoke`.

## Reports (app)

Discover → a venue → **Show courts** → **Report a problem with this listing** opens `/report/[id]`. Guests are asked to sign in there. The reporter picks one reason and can add up to 500 characters of details (line breaks allowed, no other control characters). The screen keeps one request key per report: retrying after a lost reply returns the original. Changing the reason or details after a failure starts a new key.

`POST /functions/v1/venue-reports` with a bearer token and exactly `{request_id, venue_id, reason, details}` (4 KiB cap; details must already be trimmed, with CRLF normalized to LF, and empty details sent as `null`). It returns `{outcome: created|existing, report}`. Reasons are `wrong_details`, `closed`, `not_a_venue`, `duplicate`, `inappropriate`, `unsafe` and `other`.

| Error | Status | Meaning |
| --- | --- | --- |
| `sign_in_required` / `invalid_auth` | 401 | No bearer, or it fails `getUser` |
| `invalid_request` | 400 | Body shape, unknown field (including any actor) or non-canonical details |
| `account_required` | 403 | No profile for the verified account |
| `venue_unavailable` | 404 | Not a published listing |
| `already_reported` | 409 | This player already has an open report on this listing |
| `request_reused` | 409 | The key belongs to a different report |
| `too_many_reports` | 409 | 20 open reports per player |
| `rate_limited` | 429 | `report-create` bucket: 5 per user per minute |
| `temporarily_unavailable` | 503 | Redis outage, timeout or degraded allowance (fails closed, `Retry-After: 5`), or an uncertain database reply |

The venue never sees who reported it. Reviewers see the reporter's display name and account ID. Reporters get no outcome notification (T43+).

## Console

- `/console/reports` lists the listings with open reports, oldest open report first, 50 per keyset page (`?after=<created_at>~<venue_id>`).
- `/console/reports/[id]` shows the listing, its owners and suspension state, the latest 100 reports (open first) and the latest 50 moderation events. It has these controls:
  - **Dismiss selected** / **Mark resolved**: closes the ticked open reports. Reports that arrive later stay open.
  - **Suspend listing** (fixed reason, confirmation required): takes a published listing off Discover and resolves the ticked reports.
  - **Lift suspension**: shown only for a moderation suspension.
  - **Remove an owner** (fixed reason, confirmation required).
- `POST /api/console/moderation/decide` takes `{venue_id, decision, reason, report_ids}` (8 KiB, up to 100 IDs). `POST /api/console/moderation/revoke` takes `{venue_id, owner_user_id, reason}`. Both require the same origin, verify the user, check the fresh role and reject unknown fields.

Revocation reasons: `not_owner`, `ownership_ended`, `owner_request`, `abuse`, `other`. Repeating a recorded decision returns `outcome: "existing"` and writes nothing. Closing an already-closed report with the other outcome gives 409 `already_decided`.

## What a suspension does

A moderation suspension sets `publication_status = 'suspended'` under the listing lock and records a private marker. Every booking command already locks the listing first and requires a published, verified listing, so the next statement after commit refuses:

| Refused (`venue_unavailable` or `not_owner`) | Still works |
| --- | --- |
| Rental quote and request, owner outside entry, calendar block, new session, group request, walk-in, owner acceptance of pending rentals/groups, new reports | Player booking reads, player cancellation of rentals and groups, owner decline |

Existing bookings stay as they are. Pending holds expire on their own (T32). Owner cancellation of confirmed unpaid arrival bookings and occupied sessions is the independent pilot task T40a. Online payment refunds remain deferred in T40 (user decision 2026-10-10); moderators gain no booking cancellation authority. The listing leaves Discover (public RLS shows published listings only).

**Reinstatement** undoes only a moderation suspension: it needs the marker and an active court (`active_court_required`), and it publishes the listing again. A listing suspended from the directory, or an owner draft retired by T17, has no marker (`not_moderation_suspension`); only an administrator can publish it, from the directory. Any change of status away from `suspended`, by any path, clears the marker (trigger), so a stale marker never lets moderation undo a later administrator suspension.

**Owner removal** deletes the link under the listing lock. Removing the last owner sets `claim_status = 'unclaimed'`, which also stops new bookings until a reviewed claim verifies someone again. The removed owner loses management access at once (`my_account_access`, every owner command).

## Database (`20261009120000_moderation.sql`)

- `private.venue_reports`: one open report per reporter and listing (partial unique index), `(reporter, request_id)` retry key, `reporter_user_id` set to null on account deletion, status `open|dismissed|resolved`.
- `private.venue_moderation_suspensions`: the marker described above; `venues_clear_moderation_suspension` trigger.
- `private.moderation_audit_events`: `report.submit|dismiss|resolve`, `venue.suspend|reinstate`, `owner.revoke`; actor, listing, subject (report or revoked account) and fixed reason codes only, with no free text and no FKs (same pattern as T12). Suspensions and reinstatements also add `directory.suspend` / `directory.publish` to the directory audit.
- Service-only `venue_report_submit`, `moderation_queue`, `moderation_venue_read`, `moderation_decide` and `ownership_revoke`. Private helpers `require_moderator` and `has_venue_stake` have no API grants, and the tables give no API role read or write access, `service_role` included.
- Lock order: role row, then listing (`for update`), then reports. Bookings use the same listing-first order, so a suspension and a booking serialize: whichever commits first wins, and the other sees its result. Reports serialize per reporter with a transaction advisory lock.

## Verification

```powershell
npm run test:moderation          # PGlite moderation.sql + venue-reports handler tests
npm run test:directory           # includes both, plus the updated authorization suite
npm run test:domain              # moderation readers
npm run test:discovery           # mobile report client against the real handler
npm run test:admin               # console rejection mapping
npm run test:moderation:local    # Docker SQL, real Auth/PostgREST, lock races, served Edge
npm run admin:build; npm run test:review:local   # production console moderation stage
```

`moderation.sql` (rollback-only, PGlite and Docker) covers: reports and their limits; queue and read permissions and paging; decisions and self-moderation; a forced audit failure rolling back a suspension; suspension against every booking command listed above (each first shown to work); what keeps working; reinstatement rules, including the trigger; revocation; and the moderator denial matrix. `test:moderation:local` adds:

- six concurrent retries of one report key, and competing keys from one player;
- the shipped mobile client recovering a lost committed reply;
- concurrent dismiss/resolve and concurrent suspensions;
- observed lock orders: suspension-first refuses a waiting rental or group request, rental-first keeps its booking, revocation-first refuses a waiting owner session;
- the served Edge function with Redis absent: forged JWT 401, GET 405, report 503 with no write.

## Rollout and limits

- Migration applied to local Docker only. Staging needs `supabase db push` (it also drops `set_verified_venue_owner`), then the `venue-reports` function deployed. The function reuses the `DISCOVERY_SUPABASE_*` and Upstash secrets, and `config.toml` sets `verify_jwt = false` and the import map. The console page runs wherever the console runs. Reload Metro; no native build.
- iPhone check: as a signed-in player, open a venue → Show courts → Report a problem; send a report; send another on the same listing (already reported); check VoiceOver on the reason list and large text.
- Retention (T47, [privacy](privacy.md)): report free text is cleared 180 days after a decision; moderation audit rows are kept; a deleted reporter's reports stay, anonymous. Account deletion releases an owner's venues with an `owner.revoke` row (reason `owner_request`, actor = subject).
- T39/T40 must keep refunds and manual payment reconciliation away from moderators.
- Not covered: player/account suspension; reporter notifications; appeals. `set_account_role` (admin only) is still unaudited. Trusted infrastructure (`service_role` table grants from T05, operator SQL) can still change listings directly without moderation audit.
