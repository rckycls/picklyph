# Owner venue editing (T18)

From Account, a verified owner opens **Manage your venue(s)**, selects a listing, and edits its name, street address, city/municipality, province, courts and public photos. Approved submission history also provides the entry point while a newly approved draft awaits publication. Each route has `OwnerGate` and is registered in the root stack so the native back button remains visible. This is the editor; T20 adds the owner/player mode switch.

Owners can edit only their own **approved, verified** listings. The database checks the current private ownership link on every command. It locks the listing and ownership row for writes, so revocation, suspension and competing saves serialize. Pins, publication, claim status and ownership remain admin/reviewer controls. Admins still curate through their existing console commands; an admin role alone does not grant access to these owner endpoints.

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

Saves preserve the microseconds in `updated_at`; stale versions return 409 `version_conflict`. Reload the latest listing before reapplying edits. Existing courts retain IDs and are deactivated rather than deleted. Omitted courts stay untouched, a venue has at most 40 courts, and at least one must remain active. Court surfaces are `hard`, `synthetic`, `other` or null. T22 must add allocation protection before court deactivation can affect bookings.

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
