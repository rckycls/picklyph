# Ownership review (T17)

Console reviewers decide the claims and new venues that owners send from the app ([owner submissions](owner-submissions.md)). Approving one makes the owner a verified owner of a listing in the same audited database transaction. Since 2026-10-08 a new venue is already the owner's private draft, so approving it also publishes that draft; nothing here grants a role.

## Who can do what

| Decision | Applies to | Who | Effect |
| --- | --- | --- | --- |
| Approve | Claim on a listing | Admin or moderator | Claim approved; listing `claim_status` becomes `verified`; claimant linked as owner. |
| Reject (reason) | Claim on a listing | Admin or moderator | Rejected with a fixed reason; nothing else changes. |
| Approve and publish (`approve`) | New venue | **Admin only** (it is directory curation) | The owner's draft, as they have set it up, becomes `approved` and `verified` and the submitter is linked as its owner. Needs an active court (`active_court_required`). `approve_new` (T17) no longer exists. |
| Merge and approve (`merge`) | New venue | Admin or moderator | Resolved as an existing listing (not suspended, not the draft itself); that listing becomes `verified` and the submitter is linked as its owner. The draft is retired. |
| Reject (reason) | New venue | Admin or moderator | Rejected with a fixed reason; the draft is retired. |

Retiring a draft suspends it (with a `directory.suspend` directory audit row) and ends the creator's editing. If an admin already published the draft from the directory, it stays published but its claim status returns to `unclaimed`. A decision locks the draft before the submission, the same order owner edits use, so an edit and a decision serialize.

Rejection reasons: `insufficient_evidence`, `not_owner`, `duplicate`, `not_a_venue`, `other`. Reviewers can never decide their own requests (`self_review`). Suspended listings cannot gain owners. A request is decided once: repeating the recorded decision returns `outcome: "existing"`, and any other decision gets 409 `already_decided`. Concurrent conflicting decisions serialize on the request row; exactly one wins.

Approving a second claim on a listing that already has an owner adds a co-owner; the detail page warns when there are owners or other pending claims. Owners only gain management access once the listing is also **approved** (published); see [authorization](authorization.md).

## Console

- `/console/ownership`: pending queue, oldest first, 50 per page with a keyset cursor. Each row shows the type and a duplicate signal (claims: other pending claims or existing owners; submissions: listings or submissions found nearby when it was sent).
- `/console/ownership/[id]`: listing or proposed venue, a Google Maps link to the pin, submitter (display name, account ID, history), their note, the proof photo, and for submissions every listing within 150 m (or a similar name within 2 km), **including drafts and suspended listings the submitter never saw**, plus other submissions nearby. Decision controls require ticking "I checked the proof photo…" before approving.
- `POST /api/console/ownership/decide`: same-origin JSON `{subject_id, decision, target_venue_id, rejection_reason}` (2 KiB, unknown fields rejected). The actor is the verified user; the database re-checks the role inside the transaction.
- `GET /api/console/ownership/evidence/[id]`: streams the private photo to a verified reviewer. The server fetches it with the service key, checks the leading bytes are JPEG/PNG, and returns it with `no-store`, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cross-Origin-Resource-Policy: same-origin`. Cross-site fetches (`Sec-Fetch-Site`) are refused. **No signed URL ever reaches the browser**, and the page uses a plain `<img>` so the photo never enters the Next image-optimizer cache.

Console times go through `toDisplayInstant`: Postgres returns microseconds, and the shared Manila formatter accepts at most milliseconds.

## Database (`20261007150000_ownership_review.sql`)

- Claims and submissions gain `reviewed_by`, `reviewed_at` and `review_reason`; submissions also gain `resolution` (`new`/`merge`) and `resolved_venue_id`. Check constraints tie them to the status.
- Service-only RPCs, all taking a server-verified `actor_user_id`: `ownership_review_queue`, `ownership_review_read`, `ownership_review_evidence` (object name for the trusted server only) and `ownership_review_decide`. `private.require_ownership_reviewer` locks the actor's admin/moderator row until commit, so revocation cannot race a decision.
- `ownership_audit_events` gains `claim.approve`, `claim.reject`, `venue.approve`, `venue.merge` and `venue.reject`, one row per decision in the same transaction. Since 2026-10-08 approval writes `directory.publish` to the directory audit (T17's `approve_new` wrote `directory.create`), and `venue.submit`/`venue.reject` name the draft.
- 2026-10-08: the detail adds `draft` (the owner's current listing: details, status, active courts, photos) beside `proposed` (as first submitted); nearby lists never include the item's own draft, and the queue names pending venues by the draft's current name.
- `my_owner_submissions()` (mobile, self-only) now returns the resolved `venue_id` for an approved venue submission. It still returns no evidence, notes, reasons or reviewer snapshot.

## Verification

```powershell
npm run test:directory      # includes supabase/tests/review.test.cjs (embedded PostgreSQL/PostGIS)
npm run test:domain         # review decision/cursor readers
npm run test:admin          # review helpers: error mapping, evidence headers, display times
npm run admin:build
npm run test:review:local   # Docker review.sql + actual production console against local Supabase/Mailpit/Storage
```

`test:review:local` runs `review.sql` on Docker, then the built console against local Supabase with real email-code sign-in. It covers guest, player and revoked-reviewer denial, the reviewer-only queue and detail pages, evidence bytes and headers, cross-site and actor-smuggling rejection, admin-only listing creation, a concurrent approve/reject race (one 200, one 409, one audit row), retries, draft privacy and the submitter's view. It removes its own accounts, venues, evidence, audit rows and mail.

## Staging and limits

The migration was applied to hosted staging on 2026-10-07, together with T15's. The first admin was assigned by the operator with trusted SQL, and the console runs locally against staging (`apps/admin/.env.local` with `ADMIN_SUPABASE_SECRET_KEY`). The console is not hosted yet.

Not in T17:
- Notifying submitters, or showing them the rejection reason (only the status).
- Audited ownership revocation: T08's `set_verified_venue_owner` still exists unaudited; T46 moderation should replace it.
- Evidence retention and metadata stripping (T47).

H06 (a pilot owner trial of claim and review) can now run on staging.
