# Owner pin submissions and ownership claims (T15)

Signed-in owners can **claim** an approved listing or **add their own venue** with a map pin. Both need one private proof photo. A claim is only a record for review. A new venue becomes the owner's private **draft listing** at once (since 2026-10-08, see [owner-created drafts](#owner-created-drafts-2026-10-08)): the owner can set it up while it is reviewed, but nothing is public, verified, owned or bookable until a reviewer approves it. Review and approval are in the console ([ownership review](ownership-review.md)). Sign-in uses the same account as players; there is no owner signup.

## Mobile flow

Adding and claiming are **Owner mode** actions (since 2026-10-08): every signed-in account has the Player/Owner switch on Account, and Player mode shows no add/claim entry, Discover claim link or submissions list. Owner mode is a UI context, not a permission; the server still verifies every token and pickly reviews every proof.

- **Account (Owner mode) → Add your venue** (`/owner/submit`), in three steps:
  1. Locate: address search (server-side Google geocoding), **Use my location**, or tap the map, then drag the pin onto the courts.
  2. Nearby: approved listings within 150 m, or with a similar name within 2 km, appear with **Claim this listing**. **My venue isn't listed here** acknowledges them.
  3. Details: name, address, city, province, court count (1–40), optional note (500 characters) and proof photo.
  4. Done: **Set up your venue** opens the draft in the venue editor (details, courts, photos, policies), with hours and the court calendar under **Venues**.
- **Discover (Owner mode) → venue details → Claim this venue** (`/owner/claim/[id]`) for unclaimed or under-review listings. Guests and Player mode don't see the link.
- **Account (Owner mode) → Your submissions** lists the user's own claims and venues with their review status.
- The welcome screen's **I own a court** opens Account in Owner mode (after sign-in, if needed).

Owner routes sit directly in the root stack (so the first one opened from a tab keeps the native back button) and each is wrapped in `OwnerGate`, which redirects signed-out users and Player mode to Account. The system photo picker (`expo-image-picker` 57.0.20) needs no photo-library permission prompt and requests HEIC as JPEG. Camera and microphone permissions are disabled. **This is a new native module: device review needs a new EAS development build.**

## Endpoint: `/functions/v1/owner-submissions`

Native clients only (no browser CORS). Every call needs `apikey` plus `Authorization: Bearer <user access token>`, verified with `getUser`. The actor is always the verified user, never request data. Responses are `private, no-store`.

| Request | Limit (verified user/min) | Result |
| --- | --- | --- |
| `GET ?address=` (3–200 chars) | `owner-lookup` 30 | `{candidates}`: up to 5 Philippine suggestions (label, address line, city, province, coordinates) |
| `GET ?latitude=&longitude=[&name=]` (pin inside the PH box) | `owner-lookup` 30 | `{duplicates}`: approved listings only (id, name, address, city, province, claim status, distance in metres) |
| `POST` multipart `submission` (JSON ≤ 4 KiB) + `evidence` (file) | `owner-submit` 10 | 201 created, 200 existing (retry), 409 `possible_duplicates` with the list |

`submission` is `{kind:"claim", request_id, venue_id, note}` or `{kind:"venue", request_id, venue:{name,address_line,city,province,latitude,longitude,court_count}, note, acknowledge_duplicates}`. Unknown fields are rejected. Shared readers live in `packages/domain/src/owner.ts`, and the database re-validates everything.

Both limits reject with retryable 503 when Redis fails or times out, **before** any upload or database write. Errors are 400 `invalid_request|invalid_submission|invalid_evidence`, 401 `sign_in_required|invalid_auth`, 403 `account_required`, 404 `listing_unavailable`, 405, 409 `already_verified|already_pending|request_reused|too_many_pending|possible_duplicates`, 413 `evidence_too_large`, 415 `multipart_required|unsupported_evidence`, 429 `rate_limited`, and 503 `auth_unavailable|address_search_unavailable|lookup_unavailable|submission_unavailable|temporarily_unavailable`. Logs use fixed event names only.

### Evidence

The body is read with a hard cap (5 MiB + 64 KiB) before parsing. The file must be 1 byte–5 MiB. Its **leading bytes** must be JPEG or PNG; client names and types are ignored. The server uploads it to the private `owner-evidence` bucket as `<verified user id>/<random uuid>.jpg|png`, then calls the database command. If the command does not create a record (retry, duplicate warning, rejection, outage), that upload is deleted. Cleanup failures are logged as `evidence_cleanup_failed`, and the private object remains.

The bucket is private (5 MiB, `image/jpeg`/`image/png`) and has **no `storage.objects` policies**. Players, including the uploader, cannot upload, list, download or sign evidence URLs. Only the trusted server reads it; The console streams it to verified reviewers through its own server route ([ownership review](ownership-review.md)); no signed URL reaches a browser. Photos are stored as uploaded, so metadata such as capture location may remain; T47 privacy/retention should decide on stripping and deletion. Any future storage policy must stay scoped to its own bucket.

## Database (`20261007120000_owner_submissions.sql`)

- `private.venue_claims` (T05) gains `request_id` and `note`. One pending claim per user per venue; evidence paths are unique. `service_role` loses direct write privileges, so writes go through the audited command.
- `private.venue_submissions` holds proposed venues (PH box, 1–40 courts, evidence, note, `duplicates_acknowledged`). It also keeps a reviewer-only snapshot: nearby approved/draft venue IDs and other users' pending submissions within 150 m. (Since 2026-10-08 it also creates the owner's draft listing; see below.)
- `private.ownership_audit_events` (`claim.submit`/`venue.submit`) is written in the same transaction. It has no FK, so history survives deletion (retention is T47).
- Service-only `owner_submit_claim`, `owner_submit_venue` and `owner_duplicate_candidates` take an `actor_user_id` that **must** come from the verified token. They lock the actor's profile and serialize per actor. They check that the evidence object exists under the actor's folder and is unused, that the listing is approved and not verified, and enforce a cap of 5 pending submissions per account. A repeated `request_id` returns the original record. Without acknowledgement, approved public duplicates return `outcome:"duplicates"` and nothing is written. Drafts and other claimants are never revealed.
- `my_owner_submissions()` (authenticated, self-only, 50 newest) returns id, kind, status, venue id, name, city and time, with no evidence, notes or reviewer data.
- Rejections carry a stable SQL `hint` that the function maps to the errors above.

## Owner-created drafts (2026-10-08)

Migration `20261008150000_owner_created_venues.sql` replaces "a reviewer creates the listing" with "the owner creates it". The endpoint, request and evidence rules above are unchanged.

- `owner_submit_venue` also creates the draft in the same audited transaction: `publication_status = draft`, `claim_status = pending`, `Court 1…N`, an `owner.create` directory audit row (actor: the owner), and `venue_submissions.venue_id` pointing at it. `venue.submit` audit rows now name the draft. The returned submission's `venue_id` is the draft.
- Every pending submission has a draft (`venue_submissions_draft` check); the migration backfilled drafts for T15 submissions that were still pending.
- While the review is pending, the creator is a **venue editor** (`private.is_pending_venue_creator`) but holds no `venue_owners` link. Owner reads/commands (details, courts, photos, hours, court hours, policies, calendar and blocks) admit them; bookings, `rental_require_owner` and `authorize_venue_management` still require a verified owner. `my_account_access()` returns the drafts as `pending_venue_ids` (owned venues keep their T08 meaning), so Owner mode and the Venues tab open for them.
- `my_owner_submissions()` names the draft (by its current name) while pending, the resolved listing once approved, and none once rejected.
- Decisions (see [ownership review](ownership-review.md)): approving publishes the draft and links the owner; merging or rejecting retires it (`suspended`), so the creator can no longer edit it.

Drafts stay out of every public read (venue/court RLS, `venue_photos` rows, search). Owner photo uploads still go to the public bucket under unguessable names, as in T18.

## Configuration

Server secrets are project-wide. `owner-submissions` reuses the T13 `DISCOVERY_SUPABASE_URL`, `DISCOVERY_SUPABASE_PUBLISHABLE_KEY`, `DISCOVERY_SUPABASE_SECRET_KEY`, `PICKLY_ENV` and Upstash secrets (see [discovery API](discovery-api.md#h02-setup-and-live-acceptance-gate)). Its one addition:

| Variable | Meaning |
| --- | --- |
| `GOOGLE_MAPS_SERVER_API_KEY` | Server-only Google key with **only the Geocoding API** enabled, plus a quota cap. It is separate from the iOS-restricted `GOOGLE_MAPS_IOS_API_KEY`. Without it, address search returns 503 and owners place the pin manually. |

The function uses Geocoding API v4 (`geocode.googleapis.com/v4/geocode/address/…?regionCode=PH&languageCode=en`). The key goes in the `X-Goog-Api-Key` header, never the URL. Results are filtered to the PH country component and never cached or stored. The stored pin is the owner-confirmed coordinate. The screen shows the Google map and an "Address results from Google" note. Re-check Google's display and caching terms if suggestions ever appear away from the map.

Staging status (2026-10-07): migration applied, `GOOGLE_MAPS_SERVER_API_KEY` set from the ignored `supabase/.env.owner-submissions.staging`, `owner-submissions` deployed; an unsigned request returns 401 `sign_in_required`. Signed-in device review needs the new EAS build. Operator steps for another environment: enable the Geocoding API on a server key, apply the migration to staging, add `GOOGLE_MAPS_SERVER_API_KEY` with `supabase secrets set`, and deploy with `supabase functions deploy owner-submissions` (`config.toml` sets `verify_jwt=false` and the shared import map; tokens are verified in code). Then build a new EAS development client for the image picker.

## Verification

- `npm run test:owner`: the shipped mobile client against the real handler; mobile form ↔ server parser agreement; strict parsing and messages.
- `npm run test:directory` (includes `owner.test.cjs` and `owner-handler.test.cjs`): embedded PostgreSQL/PostGIS suite plus handler/geocoder unit tests (auth first, limiter before side effects, body/type caps, cleanup, sanitized errors, key out of URLs, no server names in mobile/admin source).
- `npm run test:domain`: shared readers.
- `npm run test:owner:local`, with the local Docker stack running and migrations applied, runs three stages. First, `owner.sql` on real Postgres/Storage. Second, the **actual served function** without Redis: 401/forged-JWT 401, then lookups and submissions 503 with no storage or database change. Third, the real handler with local Auth/Storage/RPC, driven through the mobile client: evidence privacy (download, list, sign and upload all denied), direct RPC denial (42501), retries, duplicate warning/ack, competing claim, 415, self-only list, unchanged public listing, one audit row per created command. It removes only its own users, venue, evidence, audit rows and temp env file. It doesn't run against hosted data and covers no live Redis or Google calls.

H06 (pilot owners trialling evidence and review) can now run on staging; see [ownership review](ownership-review.md).
