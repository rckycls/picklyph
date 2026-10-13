# Pre-launch court registration (T53)

A public, mobile-first web page (`apps/web`, its own Vercel project and origin, separate from the console) where a court owner **with no account or password** pins their venue on a Google map, enters venue and contact details and submits. Each registration becomes a **private, unclaimed draft listing** plus a private registration row, and the owner gets an email with a **single-use claim code** to enter in the app after launch (T54). Nothing becomes public, owned, verified or bookable: drafts never appear in public reads, `venue-search` or any account's owner access, so T49's "only approved venue data" still holds. The arrival-only pilot is unaffected.

Going live needs H13 (domain, email provider, Vercel project, browser Maps key, Turnstile keys) and the **production** Supabase project and Upstash database from T50. Staging is for trials only; never copy staging registrations to production.

## The page

| Route | What it is |
| --- | --- |
| `/register` | The form. `/` redirects here. |
| `/register/done` | "Check your email" and the next steps. Carries nothing in its URL. |
| `/privacy` | Privacy notice (RA 10173: what is stored, why, who sees it, how long, rights, how to ask for removal). Reads `PRELAUNCH_CONTACT_EMAIL`. The user reviews the wording before launch (H11/H13). |
| `POST /api/address` | Server-side address search (T15 Geocoding adapter, `supabase/functions/owner-submissions/geocode.ts`). |
| `POST /api/register` | The registration command. |

The form, top to bottom: address search and a Google map with a **fixed pin in the middle** (drag the map or tap a spot; zoom 15+ and a moved map or chosen result are required); venue name, street, city, province; courts 1–40 with optional indoor, covered and surface (applied to every court); owner name, email, optional PH mobile number, role (owner, manager, staff), optional note (500 characters); consent with a link to the privacy notice; Turnstile; submit. Nearby approved listings come back as a warning the person must acknowledge ("My venue is not one of these listings") before the same submit is accepted. The browser validates with the same domain readers as the server (`packages/domain/src/prelaunch.ts`).

No cookies, sessions or tracking. Every page is rendered per request with a nonce CSP (`src/proxy.ts`, `src/lib/csp.ts`): scripts from our origin with the nonce, Google's documented Maps JavaScript API origins (including the `'unsafe-eval'` its reference policy lists) and `challenges.cloudflare.com`; frames only Google and Turnstile; `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`. API answers carry `default-src 'none'` and `no-store`. `Referrer-Policy: strict-origin-when-cross-origin` keeps the origin on Maps requests, because the browser key is restricted by referrer. The Turnstile site key and the browser Maps key reach the page as server-component props at request time, so **the built client bundle holds no setting at all**; `apps/web/tests/bundle-scan.cjs` checks for server setting names and secret-shaped values.

## `POST /api/register`

Body (`MAX_PRELAUNCH_BODY` 8 KiB, `application/json`): `{request_key, turnstile_token, acknowledge_duplicates, registration: {owner_name, email, phone, role, venue: {name, address_line, city, province, latitude, longitude, court_count}, courts: {indoor, covered, surface}, note, consent: true}}`. Unknown fields are refused. `request_key` is a UUID the page makes per form, so a retry returns the original.

Order: configuration → **same Origin** (the configured `PRELAUNCH_ORIGIN`, never the Host header; POST only) → bounded JSON → input → **Turnstile** (server-side siteverify) → **limits** (IP, then email) → `prelaunch_register` → code email → `prelaunch_email_sent`.

| Answer | When |
| --- | --- |
| 200 `{status:"sent", venue_name}` | Created, a retry of an already-emailed registration, **or** the address already has 10 open registrations (then a "we couldn't add it" notice is emailed instead of a code). The three are byte-identical, so a reply never tells whether an address registered before. |
| 200 `{status:"duplicates", duplicates:[{name, address_line, city, distance_m}]}` | Approved listings within 150 m (or a similar name within 2 km) and no acknowledgement. Nothing is written. Drafts and other registrations are never revealed. |
| 400 `invalid_input` | Field problems (the message says which), including missing consent. |
| 403 `origin_not_allowed` / `check_failed` | Wrong Origin, or Turnstile refused the token. |
| 405, 409 `start_again`, 413, 415 | Wrong method; the request key was used with another address; body too large; not JSON. |
| 429 `rate_limited` + `Retry-After` | IP or email limit; the same words for both. |
| 502 `email_failed` | The registration exists but the email didn't go out. **Try again** with the same request key: the code rotates (the unsent one stops working) and is emailed. |
| 503 `unavailable` + `Retry-After` | Not configured, Turnstile or Redis down (fail closed: **nothing written**), database unavailable. |

Logs are fixed event names (`prelaunch.created`, `prelaunch.email_failed`, …): never a code, address or body.

## Database (`20261013120000_prelaunch_registrations.sql`)

- `private.venue_registrations`: `request_key` (unique), `venue_id`, `status` (`open`, `erased`), contact details (`owner_name`, `email`, `phone` `+639…`, `role`, `note`), `consent_at`, `duplicates_acknowledged`, `nearby_venue_ids` (reviewer snapshot of approved **and draft** listings nearby, other registrations included), `code_hash` (unique), `code_version`, `email_sent_at`, `erased_at`. RLS on and no grants at all, `service_role` included: only the two commands write it.
- `public.prelaunch_register(request_key, registration, code_hash, acknowledge_duplicates)` (service-only): validates everything again, serializes per address, and returns `created | existing | duplicates | limit` with `send` and `code_version`. A new registration creates, **in one transaction**, the draft (`publication_status draft`, `claim_status unclaimed`, `Court 1…N` with the court settings), the registration and a `prelaunch.register` directory audit row whose **actor is the registration id** (no account exists). A retry whose email never went out rotates the hash (`code_version + 1`); after delivery it changes nothing. At most **10 open registrations per address** (`limit`, nothing written). The same address may register the same place twice; reviewers see both in each other's snapshot.
- `public.prelaunch_email_sent(registration_id, sent_version)` (service-only): records delivery only for the code version that was sent.
- `private.privacy_retention_sweep` now also erases registrations still open **180 days after their last code email** (or after creation if none was delivered): contact details, note and code hash become null, and a still-draft listing is suspended with a `prelaunch.retire` audit row. A listing an admin already published stays. It locks the listing before the registration, like other venue commands. Its result gained `prelaunch_registrations`.
- `private.directory_delete_blocker` names `registration`, so the console's bulk Delete skips these listings ("suspend it instead").

## Claim codes

10 characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789` (no 0/O, 1/I/L, U), uniformly drawn from the server's CSPRNG, printed as `ABCDE-FGHJK`. Only `HMAC-SHA256(PRELAUNCH_CODE_SECRET, "pickly-claim-code:v1:" + code)` (hex) is stored. `normalizeClaimCode` (domain) accepts any case, spaces and dashes for T54. Codes are emailed once per version and never logged; the provider's `Idempotency-Key` is `prelaunch-<registration id>-v<version>`.

## Limits, Turnstile and email

- **Upstash** (`src/lib/limits.ts`): one atomic REST `/multi-exec` per check (`SET key 0 PX window NX`, `INCR`, `PTTL`), keys `pickly:<env>:<action>:<ip|email>:<HMAC-SHA256(RATE_LIMIT_KEY_SECRET, kind:id)>`, so Redis sees no IP or address. `prelaunch-register`: 10 per IP per 10 minutes and 10 per address per hour; `prelaunch-lookup`: 30 per IP per minute. The client IP is Vercel's own `x-vercel-forwarded-for`, read **only when `VERCEL=1`**; anywhere else everyone shares one bucket. Errors, timeouts (800 ms) or odd replies fail closed. The direct REST call (not `@upstash/ratelimit`) lets the local harness use a loopback stand-in.
- **Turnstile** (`src/lib/turnstile.ts`): siteverify before any write; real results must name our hostname and the `register` action. Cloudflare's dummy keys (their results carry `metadata.result_with_testing_key`) pass only outside production, and production refuses a dummy secret outright. A refused secret or unreachable siteverify is an outage (503).
- **Email** (`src/lib/email.ts`): Resend's HTTP API (`EMAIL_API_URL` may point elsewhere with the same request shape). Plain text plus simple HTML: the venue, the code, the next steps (get the app at launch, sign in, enter the code in Account), the 180-day erasure and how to ask for removal.

## Configuration (`apps/web/.env.example`)

All settings are server-side and read per request; a missing one answers 503 instead of failing the build.

| Setting | Notes |
| --- | --- |
| `PICKLY_ENV` | `local`, `staging` or `production`. Hosted environments need https; only `local` accepts http (loopback or a LAN address) and loopback stand-ins for Upstash, Supabase and email. |
| `PRELAUNCH_ORIGIN`, `PRELAUNCH_CONTACT_EMAIL` | The page origin and the privacy/removal address (also the email's reply-to). |
| `PRELAUNCH_SUPABASE_URL`, `PRELAUNCH_SUPABASE_SECRET_KEY` | **Production project** for live registrations. Server-only secret key. |
| `PRELAUNCH_CODE_SECRET` | 32+ characters. T54 needs the same value; rotating it voids outstanding codes. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `RATE_LIMIT_KEY_SECRET` | That environment's Upstash database. |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | For the domain (H13). |
| `GOOGLE_MAPS_BROWSER_API_KEY` | Maps JavaScript API only, restricted to the domain's referrers; separate from the iOS and server keys. |
| `GOOGLE_MAPS_SERVER_API_KEY` | Geocoding only (the T15 server key). |
| `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_API_URL` (optional) | Provider key and a sender on the verified domain. |

`release:check`'s bundle scan also refuses the four new secret names in the mobile app.

## Run it and check it on an iPhone

```
npm run web:build
npm run web:dev
```

For the iPhone (Safari), run it on the network with `PICKLY_ENV=local`, `PRELAUNCH_ORIGIN=http://<this PC's LAN IP>:3200`, Cloudflare's test Turnstile keys and a browser Maps key that allows that address as a referrer (or a separate unrestricted dev key, deleted afterwards), then open the same address on the phone: `npm --workspace @picklyph/web run start -- --hostname 0.0.0.0 --port 3200` after a build. Check: map drag/tap and zoom, address search, the duplicate warning, Turnstile, keyboard and large text, the done page and the email. No agent browser previews are used for this page.

## Verification

- `npm run test:prelaunch`: PGlite SQL suite (`supabase/tests/prelaunch.sql`) plus 17 mutations of the new functions, all caught.
- `npm run test:web`: handler and service tests (Origin, body bounds, Turnstile fail/outage, limits and outage, retries, enumeration-free replies, send failure and rotation, code collisions, configuration, CSP, client IP, email content, code sampling and hashing).
- `npm run test:domain`: contract readers and claim-code normalization.
- `npm run test:web:local` (after `npm run web:build`, local Docker Supabase running with the migration applied): Docker SQL suite, bundle scan, then the real production server with loopback Upstash and email stand-ins and Cloudflare's test keys: pages and CSP, cross-site/oversized refusal, registration → private draft (anon read, bounds read and search see nothing; anon can't call the commands) → one email whose code matches the stored hash → retry returns the original → failed send then rotation → duplicate acknowledgement → 429 and Redis outage 503 with no write → no code in logs → always-fail Turnstile 403. It removes its own rows.

## Rollout status

- **Local Docker** and **hosted staging** (2026-10-13, at the user's request after a dry run listing only `20261013120000`; no seeds or roles) have the migration. On staging, anonymous calls to `prelaunch_register` and `prelaunch_email_sent` answer 401/42501 and `venue_registrations` is not exposed. Staging is for trials: point a local or preview run of the page at it, never live registrations.
- **Production**: the migration goes with T50's production project. The page is not deployed anywhere yet (H13).

## Going live (H13) and next steps

1. H13: domain and DNS; Resend with the domain verified (SPF/DKIM) and a server key; a Vercel project for `apps/web` (root `apps/web`, the npm workspace install) on the domain; a referrer-restricted browser Maps key; Turnstile keys for the domain.
2. T50's production Supabase project with this migration, and production Upstash. Set every setting above in Vercel (production), with `PICKLY_ENV=production`.
3. Check once on the deployment: a registration lands as a production draft, the email arrives, and Upstash shows `pickly:production:prelaunch-*` keys (proves the REST transaction format against the real service); a request from another origin is refused.
4. The user reviews the privacy notice wording (joins H11).
5. **T54** redeems codes in the app (single-use, rate-limited, lockout), lists registrations in the console (contacts admins only), resends or rotates codes at launch (the sweep counts from `email_sent_at`) and retires spam. A claim should lock the listing before the registration, like the sweep.
