# Owner venue editing (T18)

From Account, an account with a current verified, approved venue selects **Owner mode**, opens **Manage your venue(s)** or the **Venues** tab, and edits a listing’s details, courts, photos and booking policies. Player mode hides venue management controls. Approved submission history alone never enables management. Editor routes remain in the root stack with a native back button; `VerifiedOwnerGate` checks current access. Submission/claim routes retain the auth-only `OwnerGate` so new owners can apply.

Owners can edit only their own **approved, verified** listings, plus (since 2026-10-08) the **draft they created** while its review is pending ([owner-created drafts](owner-submissions.md#owner-created-drafts-2026-10-08)). The database checks the current private ownership link, or the creator's pending submission, on every command. It locks the listing and ownership row for writes, so revocation, suspension and competing saves serialize. Pins, publication, claim status and ownership remain admin/reviewer controls. Admins still curate through their existing console commands; an admin role alone does not grant access to these owner endpoints.

## Contract and boundaries

`GET /functions/v1/owner-venues` lists up to 50 linked listings, including a status explaining why a draft or suspended listing cannot be edited. `GET ?venue_id=<uuid>` returns one editable venue, its courts (including inactive ones) and photos. Reads are limited to 60 requests per verified user per minute and may continue as bounded database reads during a Redis outage.

`POST` JSON accepts exactly one of:

```json
{
  "kind": "save",
  "venue_id": "<uuid>",
  "expected_updated_at": "<exact database timestamp>",
  "venue": { "name": "...", "address_line": "...", "city": "...", "province": "..." },
  "courts": [{ "id": "<existing uuid or null>", "name": "Court 1", "surface": "hard", "is_indoor": false, "is_covered": true, "status": "active" }]
}
```

```json
{ "kind": "remove_photo", "venue_id": "<uuid>", "photo_id": "<uuid>" }
```

Saves preserve the microseconds in `updated_at`; stale versions return 409 `version_conflict`. Reload the latest listing before reapplying edits. Existing courts retain IDs and are deactivated rather than deleted. Omitted courts stay untouched, a venue has at most 40 courts, and at least one must remain active. Court surfaces are `hard`, `synthetic`, `other` or null. Since T22, a court with a live allocation (block, booking or unexpired hold) that has not ended cannot be deactivated: the save returns 409 `court_allocated` (a `courts` trigger enforces this on every path, including admin curation and trusted SQL). Release blocks in the owner calendar first.

`POST` multipart contains exactly a `photo` JSON string (`venue_id`, `request_id`) and one `file`. Native uploads append an `expo-file-system` `File` and use `expo/fetch` through the existing deadline wrapper; never use `instanceof Response` in mobile code.

Every mutation/upload shares a limit of 20 requests per verified user per minute. 429 includes `Retry-After`; Redis errors and SDK timeout allowances fail closed with retryable 503 before reading the body or changing Storage/database state. All requests verify the bearer using Auth `getUser`; no actor comes from request JSON. There is no browser CORS. Replies are private/no-store and infrastructure errors are sanitized.

## Photos and storage

- JPEG or PNG, identified from bytes, at most **5 MiB**. Request streams are bounded (32 KiB JSON; 5 MiB plus 64 KiB multipart overhead).
- Display dimensions: each side **320–8192 pixels**, at most **25 million pixels**, measured from the image headers with JPEG orientation applied. Six photos per venue; the listing lock serializes the cap.
- The server rebuilds JPEG segments/PNG chunks before uploading. It drops identifying EXIF/GPS/device/date data, XMP/IPTC, comments, thumbnails, text/time chunks, ICC profiles and trailing bytes. A minimal JPEG orientation tag preserves rotation; fixed Adobe color-transform fields and PNG palette/transparency/numeric color fields remain. Removing ICC profiles can change wide-gamut color rendering.
- PNG validation checks chunk bounds/CRC, header fields, critical chunks and IDAT/palette ordering, following the [W3C PNG specification](https://www.w3.org/TR/png/). JPEG validation checks segment/frame/scan structure and supports 8-bit baseline/extended/progressive Huffman photos. Compressed pixel data is copied; this is not a complete pixel decode/re-encode. Tests decode real baseline/progressive JPEG and PNG output with Sharp and compare pixels. Library HEIC images request iOS's compatible JPEG representation; other formats are rejected by the server.
- Objects live in the public `venue-photos` bucket under server-generated `<venue UUID>/<random UUID>.jpg|png` names. There are no client Storage write/list policies. Clients also cannot mutate `venue_photos` or call owner RPCs directly; only the stateless service client executes the guarded commands. Private request records contain uploader/request IDs; public rows contain neither.
- Guests read photo rows only for approved venues. The expanded Discover venue card displays up to six photos. A public bucket's known object URL remains readable after suspension; row visibility hides the gallery, not the bytes. These photos are public, unlike T15 ownership evidence.
- Repeating a successful upload's request ID returns the existing gallery, even when full, and removes the redundant upload. Removal is a no-op when already removed. Photo changes do not change the venue detail version. Removing a photo also removes its request record; a later replay of that old upload request is a new add.
- Storage and database commits cannot share a transaction. Definitively rejected/duplicate uploads are deleted; an unknown RPC failure retains its object because the reply may have been lost after commit. Retry the same request ID. Removal commits the row/audit first, then deletes bytes; cleanup failures log a fixed event only. Orphaned objects require operator reconciliation before deletion, and removed public bytes may be cached. No cleanup worker is included here; T47 must define retention/reconciliation.

Each successful save/add/remove writes `owner.update`, `owner.photo_add` or `owner.photo_remove` in the existing private directory audit, inside the same database transaction. Audit failures abort the mutation. Rejected/duplicate/no-op commands add no event. No request payload, photo bytes or credentials enter the audit.

## Setup and verification

Migration `20261007180000_owner_venues.sql` creates the bucket, read-only public photo rows, private retry records, owner commands and audit actions. It is applied locally. **Hosted staging is not changed by T18.** Deploy this migration, then deploy `owner-venues` using `supabase/config.toml` (gateway JWT verification is disabled because the function independently verifies all bearers). The new public detail query reads `venue_photos`; missing-table errors alone return an empty photo list during rollout so existing venue/court details remain usable. Other query errors surface. Reuse the project-wide T13 server secrets: `DISCOVERY_SUPABASE_URL`, `DISCOVERY_SUPABASE_PUBLISHABLE_KEY`, `DISCOVERY_SUPABASE_SECRET_KEY`, `PICKLY_ENV`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RATE_LIMIT_KEY_SECRET`. None goes in the app; no new secret or dependency was added.

Run `npm run test:venues:local` with local Supabase/Docker running. It never reads the mobile/hosted environment: SQL fixtures roll back, actual local Auth/Storage/RPC checks exercise the shipped client/handler, and the served Edge function checks forged tokens plus fail-closed Redis outage behavior. Only synthetic fixture accounts, venue, photos and audit are removed; the temporary credential file is deleted and only the test's child CLI is stopped. Sharp is supplied by the existing Next.js dependency tree for real-image tests.

Additional checks: `npm run test:directory`, `npm run test:owner`, `npm run test:domain`, `npm run test:discovery`, `npm run typecheck`, `npm run lint`, `npm run functions:check`, `npm run functions:lint`, `npm run test:functions`, `npm run admin:typecheck`, `npm run test:admin`, `npm run bundle:ios`.

Physical iPhone acceptance remains: after staging deployment and Metro restart, sign in as a verified owner of an approved venue; check entry/list/back navigation, detail/court saves, unsaved-change behavior, stale-version recovery, JPEG/PNG selection/upload/retry/removal, photo strip in Discover and revocation/suspension failures. Check large text/VoiceOver. Existing T15 image-picker/file-system modules suffice; a native rebuild is unnecessary for these JavaScript-only changes. No device or browser layout acceptance is claimed.

## Owner mode and policies (T20)

Mode starts in Player context on each account identity/cold restore. `OwnerModeProvider` calls the self-only `my_account_access()` on navigation and every AppState change; controls stay unavailable while access is unknown or failed. Requests carry identity/generation guards, and changing accounts discards pending callbacks and prior mode. Revocation/suspension removes the venue on the next check. Account shows a checking/error/retry state. During foreground checks an already authorized editor stays mounted with its content hidden and interactions/accessibility disabled, preserving unsaved changes and photo-picker results. The chosen Venues tab remains present while checking.

Since 2026-10-08 **every signed-in account** can choose Owner mode once access has been checked, venue or not: it is where owners add or claim a venue. A failed check still falls back to Player. In Owner mode with no venue, the Venues tab shows how to add or claim one; venue editor, hours and calendar routes still need a managed venue (`VerifiedOwnerGate`). Player mode hides adding, claiming and submissions entirely.

`GET /functions/v1/owner-venues?venue_id=<uuid>&section=policies` returns `{policy:{venue_id,revision,confirmation,payment,merchant_active}}`. `POST` JSON accepts exactly:

```json
{"kind":"save_policy","venue_id":"<uuid>","expected_revision":"0","policy":{"confirmation":"approval","payment":"arrival"}}
```

Confirmation is `instant` or `approval`; payment is `arrival`, `online` or `both`. An absent private policy record reads as **instant/arrival**, revision `"0"`. Successful saves increment an independent bigint-string revision; concurrent/stale forms return409. Detail/photo/schedule saves do not change the policy version. The same T18 verified-owner checks, body bounds, verified-actor limits and fail-closed write guard apply. Owner/admin role alone cannot edit another venue. Each success atomically appends `policy.update`; audit failure rolls back the policy/version.

Private `venue_merchants` holds trusted activation state. Both merchant/policy tables have RLS and no API-role grants (including service role); only service-only read/save wrappers execute. Neither owner JSON nor a client/service table write can activate a merchant. T20 adds **no merchant onboarding/activation endpoint**. Online/both saves require current activation; loss of activation makes the effective read return arrival. UI choices remain disabled without activation, and forged bodies cannot override the database. Synthetic SQL test fixtures alone exercise activation.

T36 must implement verified provider activation with the same venue-first, merchant-second lock order and increment policy revision on activation changes. T24/T27/T35 must read the effective policy inside their booking transaction and snapshot it; the owner UI’s mode/policy is presentation, never command authorization or an availability promise. Existing bookings will use their snapshots.

Migration `20261008000000_venue_policies.sql` is applied locally only. Hosted rollout needs T18–T20 migrations plus `owner-venues` redeployment. Reuse existing server secret names; no new dependencies/native modules. `npm run test:policies:local` covers Docker SQL plus real Auth/mobile-client/handler/PostgREST races and served Edge forged-token/outage denial, then removes only its fixtures/temp credentials. Restart Metro if generated route types/cache include outside-app paths.

Device acceptance remains: player has no mode/management; verified owner switches both ways and navigates Venues/editor/back; instant/approval and arrival saves persist; online choices remain disabled; concurrent form conflicts reload; foreground/revocation/account-change checks hide stale controls; photo picker and unsaved detail/policy state survive an access recheck. Review VoiceOver and large text. No iPhone acceptance or hosted deployment is claimed.
