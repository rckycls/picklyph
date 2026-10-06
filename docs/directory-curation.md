# Directory curation (T11)

Administrators open `/console/directory` to browse up to 100 venues per page,
create drafts, edit venue/court details, publish, return to draft or suspend.
Moderators can use the console foundation but cannot access directory curation.
Ownership review, bookings and transactional audit records are later tasks.

## Setup

T11 adds `supabase/migrations/20261007030000_directory_curation.sql`. It has been
applied and tested on the local Docker database; hosted staging currently has
T05/T08 only. Apply T11 to the verified staging project when deploying these tools:

```powershell
npx supabase db push --project-ref fkdusdurzdgbfwwigrqw --dry-run --skip-vault
npx supabase db push --project-ref fkdusdurzdgbfwwigrqw --skip-vault
```

Add `ADMIN_SUPABASE_SECRET_KEY` to the existing ignored `apps/admin/.env.local`,
using a server secret key from the **same project** as the URL/publishable key.
Restart the admin server after changing env. Modern `sb_secret_` keys are
supported; local CLI legacy `service_role` keys also work. The key is read only
by `server-only` code, through a client separate from cookie authentication.
Do not give it a `NEXT_PUBLIC_` prefix or place it in mobile config. An existing
Auth account also needs an intended admin assignment through the trusted
[first-administrator bootstrap](authorization.md#first-administrator).

The implementation does not retrieve/save hosted secret keys, promote users,
publish fixture venues or deploy the website. T10 sign-in still works without a
server secret; directory tools show an unavailable state until configured.

## Editor behavior

- Required venue fields: name (1–120 characters), address (1–240), city and
  province (1–80 each), finite numeric latitude (-90 to 90) and longitude
  (-180 to 180). The country stays PH. Confirm the actual venue location before
  publishing; global coordinate validation does not verify a Philippine address.
- Court names are unique within a venue, 1–80 characters; surface is null,
  `hard`, `synthetic` or `other`; indoor/covered are booleans; status is active or
  inactive. At most 40 courts per venue. A draft may have no courts; publication
  requires at least one active court. Unpublish before deactivating the last one.
- Saving edits preserves publication and claim status, court IDs, omitted courts,
  private evidence and ownership links. Existing courts are deactivated rather
  than deleted; drafts and suspension replace hard venue deletion. A cross-venue
  court ID is rejected. Existing court names cannot be swapped in one save due
  to their unique constraint; rename through a temporary unique name if needed.
- Each edit/publication supplies the original `updated_at` without rounding its
  microseconds. A changed version returns 409; reload before editing again.
  Unsaved browser edits disable publication controls.
- Publication exposes only the venue and its active courts. Returning to draft
  or suspending hides both. Publication does not verify a claim, assign an owner,
  enable booking or create/change allocations.

## JSON import

Use `/console/directory/import` to choose/paste JSON, validate and preview names,
cities and court counts, then import as drafts. The downloadable example is
fictional and is never a seed or a permissioned real listing. The envelope is:

```json
{
  "listings": [{
    "reference": "your-source:permanent-venue-reference",
    "venue": {
      "name": "Replace with permissioned venue details",
      "address_line": "Replace with its actual address",
      "city": "Manila",
      "province": "Metro Manila",
      "latitude": 14.6,
      "longitude": 121
    },
    "courts": [{
      "id": null,
      "name": "Court 1",
      "surface": "hard",
      "is_indoor": false,
      "is_covered": true,
      "status": "active"
    }]
  }]
}
```

Import 1–25 entries in at most 256 KiB; references are unique, trimmed strings of
1–120 characters and should include your source namespace. Every field shown
is required; court arrays may be empty, and new court IDs must be null. Unknown
fields, duplicates and claimed publication/ownership/actor values are rejected.

The whole batch commits or rolls back together. Private references remember the
original validated payload. An identical retry returns `existing` without
duplicating records, restoring draft status or overwriting later manual edits.
A reused reference with different data returns 409; edit the original listing
instead. Object key order is immaterial; court-array order/content is part of the
payload. Concurrent overlapping batches acquire ordered transaction locks and
create each reference once. Different references/manual creates are not deduped
by name or coordinates; review the directory before adding another venue.

## Authorization and verification

POST save/publish/import requires the configured Origin. The server verifies
`auth.getUser()` and the current admin role before parsing bounded JSON (32 KiB
for save/publication; 256 KiB for import). It derives the actor from that verified
user and calls only the service-only directory RPCs. Each SQL command then checks
and locks the current admin assignment in the same transaction. The lock holds
until commit, so revocation cannot interleave after that check. User-facing
responses are sanitized and private/no-store. No infrastructure key/token is
returned to the browser. Data-bearing pages independently verify access even
when a layout persists during navigation; the SQL read RPC also checks the actor.

Private import references have RLS with no client grants/policies. Read RPCs
return only directory fields/courts; claim evidence and owner/account tables
are excluded. Private helpers have no client/service execute grant. The service
key remains powerful infrastructure, not proof that a caller is an admin.

```powershell
npm run test:directory
npm run test:domain
npm run test:admin
npx supabase migration up --local
npm run admin:typecheck
npm run admin:lint
npm run admin:build
npm run test:admin:local
npm run typecheck
npm run lint
```

The embedded PostgreSQL/PostGIS and Docker SQL suites verify input/permission
denial, drafts/publication, preserved evidence/court identity, stale versions,
bounded pagination and atomic import/retry behavior. The local production Next
integration uses only its own random Auth/venue/mail fixtures, tests actual
cookie auth, editor HTML, route errors, public visibility, concurrent imports
and revocation, then removes fixtures and stops its child server. It never
reads hosted/mobile env. Browser layout, keyboard interaction and hosted
console acceptance remain manual checks; no new iPhone binary is needed.

Sources: [Supabase server API keys](https://supabase.com/docs/guides/getting-started/api-keys),
[database function security](https://supabase.com/docs/guides/database/functions).
