# Bounded venue discovery (T13)

`GET /functions/v1/venue-search` returns approved directory records. It reports no availability, prices, owner contact, or bookability. A verified claim is not a booking permission. The T14 mobile client is described [below](#mobile-client-t14).

## Request and response

At least one selector is required: complete `south`, `west`, `north`, `east` bounds; `city` (2–80 characters, case-insensitive exact match); or `name` (3–120 characters, case-insensitive literal substring). Selectors intersect. Bounds are inclusive WGS84 latitude/longitude, cannot cross the antimeridian, and can span at most 30 degrees on each axis. A single bounds query can cover the Philippines. Optional `indoor=true|false`, `covered=true|false`, and `surface=hard|synthetic|other` all apply to the **same active court**. Without court filters an approved venue can have zero active courts.

`limit` defaults to 25 and must be an integer from 1–50. `after` accepts the previous `next_cursor` UUID. Results sort by immutable venue UUID and use one-row lookahead. An empty/final page has `next_cursor:null`. Keep the same selectors/filters for subsequent pages; reset the cursor when they change. This is live keyset pagination, not a frozen snapshot: publication/edits during paging can change membership, and a newly added earlier UUID requires refreshing the first page.

Unknown/repeated parameters, empty values, partial/reversed/oversized bounds, control characters, invalid UUIDs, and malformed filters are rejected. Name `%`, `_`, and backslash are literal characters, never SQL wildcards. Query size is capped at 2KiB after URL serialization and the complete URL at 4KiB.

Example: `?south=4&west=116&north=22&east=127&covered=true&limit=25`.

```json
{
  "venues": [{
    "id": "00000000-0000-4000-8000-000000000001",
    "name": "Example court venue",
    "address_line": "Example address",
    "city": "Manila",
    "province": "Metro Manila",
    "country_code": "PH",
    "latitude": 14.6,
    "longitude": 121,
    "claim_status": "unclaimed",
    "active_court_count": 2
  }],
  "next_cursor": null
}
```

Guests send the public `apikey` header, with **no Authorization header**. Signed-in requests additionally send `Authorization: Bearer <user access token>`. Do not use the SDK's automatic anonymous bearer token for guest calls: every supplied bearer token must verify as an Auth user through `getUser(token)`. Invalid/expired/forged tokens return 401 rather than silently becoming guests. Auth infrastructure failures return retryable 503. An API key, metadata, body/query UUID or caller identity header cannot identify a user. Responses are private/no-store; browser CORS allows GET/OPTIONS and exposes retry/rate headers. Native clients need no Origin header.

Errors: 400 `invalid_search`, 401 `invalid_auth`, 405 `method_not_allowed`, 429 `rate_limited`, 503 `auth_unavailable|search_unavailable|temporarily_unavailable`. Retryable responses include `Retry-After` seconds. Enforced limits expose `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds). No raw infrastructure errors or tokens appear in responses.

## Database boundary

Migration `20261007090000_directory_search.sql` adds `directory_search(search jsonb)` with service-only EXECUTE and independent strict input validation. It explicitly projects approved public fields even though the service client bypasses RLS. Court filters/counts consider active courts only. Private claims/evidence never enter the query. Existing public table RLS and the T05 capped bounds primitive remain unchanged; T13 limits its new endpoint, not every existing PostgREST directory read. No client mutation privileges are introduced.

Search uses the existing GiST spatial index, a partial lowercase-city index and a partial lowercase-name trigram GIN index. UUID keyset pagination avoids growing offsets; only the capped result page has court counts. The Edge database/Auth requests each have a 4-second fetch deadline. This cancels the HTTP wait, not a guarantee of PostgreSQL statement cancellation. Database workload/timeouts still need monitoring in T51.

## Reusable server guard

Use `buildUpstashGuard(env)` from `supabase/functions/_shared/upstash.ts`, initialized once outside the handler. Run it **after independent identity verification and before any mutation/payment side effect**. `RatePrincipal` is trusted server input, never parsed from a request. Rate authorization does not replace an actor check inside the database transaction, idempotency, or transactional auditing. Protected mutation RPCs must remain service-only so commands cannot bypass the guard.

| Action | Limit per minute | Redis error/timeout policy |
| --- | --- | --- |
| discovery | guest 30; verified user 60 | Continue bounded search |
| owner-submit | verified user 10 | Reject 503 before changes |
| hold-create | verified user 10 | Reject 503 before inventory changes |
| checkout-create | verified user 5 | Reject 503 before payment changes |
| cancel | verified user 30 | Continue on outage |
| provider-webhook | no Redis limit | Bypass only after verified provider signature |

Creation/cancellation guard calls reject guest/provider principals. Webhook bypass rejects all principals except a server-verified provider; later handlers must verify the signature before calling it. Auth still uses Supabase's own limits. A known Redis denial returns 429 with at least one second of retry delay. The guard detects both thrown errors and the SDK's `success:true, reason:"timeout"` result; a separate 800ms deadline also covers stalled calls. SDK timeout is 650ms, retries/analytics/ephemeral cache are disabled. A timeout may leave a Redis request finishing in the background; no business side effect is permitted before an allowed guard result.

Namespaces include environment/action/principal kind. Identifiers are HMAC-SHA256 of principal kind and verified UUID or trusted source IP, using a private secret. Redis receives no raw IP/token/user UUID, and analytics is disabled. Guest IPv6 is canonicalized. No inventory, booking lock, event outbox or payment idempotency state goes to Redis. Cancellation and authenticated provider events remain processable during an outage.

Missing/invalid Redis configuration also follows those outage policies. Degraded discovery emits one fixed sanitized warning per minute per warm isolate, without identifiers/query/secret values. No enforced-rate headers are invented on degraded responses. Alerting is T51.

## H02 setup and live acceptance gate

T13 was validated locally; no Upstash database/account or hosted function was created. H02 requires separate staging and production Redis databases near the server region. Environment prefixes provide additional isolation but do **not** replace separate databases/tokens.

Set these server-only function secrets through an ignored env file/hosting secrets; never paste values into chat or commit them:

| Variable | Meaning |
| --- | --- |
| `DISCOVERY_SUPABASE_URL` | Same-project hosted Supabase HTTPS URL |
| `DISCOVERY_SUPABASE_PUBLISHABLE_KEY` | Same-project public key, used only to verify users |
| `DISCOVERY_SUPABASE_SECRET_KEY` | Same-project server key for the service-only search RPC |
| `PICKLY_ENV` | `staging` or `production`; local tests use `local` |
| `UPSTASH_REDIS_REST_URL` | HTTPS REST origin ending in `.upstash.io`, without credentials/query/path |
| `UPSTASH_REDIS_REST_TOKEN` | That environment's private Redis REST token |
| `RATE_LIMIT_KEY_SECRET` | Independent random secret of at least 32 characters per environment |
| `DISCOVERY_IP_SOURCE` | Default `unknown`; opt into `cloudflare` only after verifying hosted ingress |

`unknown` ignores all caller forwarding headers and groups guests into one conservative bucket. `cloudflare` reads only the single canonical `CF-Connecting-IP` supplied by the trusted hosted Cloudflare ingress; missing/malformed values fall back to the shared bucket. It never trusts the first `X-Forwarded-For` entry. Do not enable this mode for local/self-hosted ingress or a directly reachable origin. The hosting boundary, not a header's spelling, establishes trust.

Before enabling per-IP mode, use staging requests with absent and forged `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP` and equivalent IPv6 text. Verify the ingress rejects/overwrites forged authoritative headers and source limits cannot be bypassed. Verify successive guest/user calls reach 429 with retry headers using the real Redis database; wait until reset and confirm recovery. Repeat for an unavailable Redis endpoint and creation guards, proving search continues and creation stops before changes. Check environment isolation and secret exclusion from client outputs/logs. If authoritative-header behavior cannot be verified, retain `unknown` mode.

Applying hosted migrations and deploying this function are separate operator actions. Hosted staging currently has T05/T08 only; apply the reviewed pending T11/T12/T13 migration chain before deploying. `verify_jwt=false` is intentional for guest access; supplied tokens are verified inside the function. Do not promote hosted users or change Auth/SMTP settings as part of this setup.

Implementation references: [Supabase rate limiting](https://supabase.com/docs/guides/functions/examples/rate-limiting), [Supabase function configuration](https://supabase.com/docs/guides/functions/function-configuration), [Upstash timeout/cache behavior](https://upstash.com/docs/redis/sdks/ratelimit-ts/features), [Upstash result fields](https://upstash.com/docs/redis/sdks/ratelimit-ts/methods), [Cloudflare authoritative IP header](https://developers.cloudflare.com/fundamentals/reference/http-headers/).

## Mobile client (T14)

`src/features/discovery/searchClient.ts` builds each request from the settled map region (600ms debounce, outward 4-decimal rounding, spans capped at 29.99°) plus Indoor/Outdoor, Covered and surface filters, which apply to the same active court. Pages hold 25 venues; Load more follows `next_cursor` with the same query. A new area or filter aborts the previous request and stale responses are ignored. At most 200 venues stay loaded, after which the player zooms in. Panning keeps current markers until the new area loads; changing filters clears results and the selection.

Guests send only `apikey`. Signed-in players send their own access token; a 401 retries once as a guest because discovery is public. Responses are strictly validated, so an unexpected shape shows the directory as unavailable rather than a guessed listing. 429/503 retry hints are shown; countdown, offline and empty-state polish is T16.

Map and list share one selected venue. The detail sheet reads the current record from the public `venues`/`courts` tables under T05 RLS (approved venues, active courts only). A suspended or unpublished venue shows "No longer listed" and leaves the results. These existing public reads are not behind the Upstash guard. Every listing says it is not bookable in pickly and tells players to contact the venue directly; Apple/Google Maps directions use the current coordinates, and pickly never sends the player's location. The directory has **no public phone/website fields** yet, so no contact details are shown. Map bounds near a player's location do reach this endpoint as query parameters (never Redis).

Device review is pending. It needs the hosted T11–T13 migrations, the `venue-search` deployment with its secrets, and at least one published staging venue. Then, signed out and signed in on the development build: pan/zoom and confirm results update; toggle each filter; use Load more; select a marker and confirm the list highlights it, and the reverse; open both directions links; suspend the venue in the console and reopen details to see "No longer listed"; check VoiceOver labels for chips, rows and markers, plus large text.

## Verification

`npm run test:search` covers strict shared parsing, guest-source trust/canonicalization, guard policies/deadlines, environment/HMAC isolation, endpoint auth/errors and real embedded PostgreSQL/PostGIS spatial/filter/pagination/permissions. `npm run test:functions` uses the pinned real Upstash SDK against in-memory REST responses, including its actual 650ms fail-open timeout; this is not a live Upstash test.

With the existing local Docker Supabase stack running and migrations applied: `npm run test:search:local`. It runs rollback-only SQL, then serves the actual function with ephemeral local keys and **no Redis configuration**. It also drives the shipped T14 mobile client and detail loader against that endpoint and local PostgREST. It verifies actual guest/player HTTP, forged JWT rejection, RPC denial, filters, suspension visibility, sanitized output and bounded Redis-outage fallback. It removes only its own generated user/venue/env file and stops its own CLI child. No hosted/mobile env is read. Do not run it concurrently with another local function-serve session.

`npm run functions:check`, `npm run functions:lint` and `npm run test:functions` invoke pinned Deno 2.9.6 through npm exec; first use needs network/package cache. Upstash/SDK dependencies are pinned in `supabase/functions/deno.json` and `deno.lock`, outside the mobile/admin npm bundle. Shared type-only imports include `.ts` so Deno and workspace TypeScript resolve the same contracts without unstable resolution flags.
