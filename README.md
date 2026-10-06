# PicklyPH

An iOS-first pickleball court finder and venue manager for the Philippines.
Players will discover courts, rent a court, or join group open play. Verified
owners will pin and manage venues through the same account.

## Current state

The Expo app opens on Discover, with Bookings and Account tabs and shared branded
controls. Discovery now has a Google Maps screen, three labeled development-only
sample locations, a selected-venue sheet, and optional foreground location.
The iPhone development build succeeds, and Google map rendering, marker/detail
selection, panning, location recentering and permission-denied browsing pass
on-device. T04 is complete. Expo Go shows a
setup fallback instead. T05 adds venue/court migrations, protected public reads,
private claim evidence, shared types and a lazy public Supabase client.
T07 adds Apple/email-code sign-in, secure native sessions, sign-out and protected
Bookings navigation. The user confirms the full T07 iPhone checklist passes;
see [auth setup and device checks](docs/auth-setup.md).
T08 adds private role assignments, venue-scoped verified ownership, self-only
profiles and actor-checked server authorization. SQL/API allow-deny tests pass
on local Supabase; hosted migrations are not deployed.
See [account authorization](docs/authorization.md).
The map still uses demo data; live directory screens, search, reservations,
payments and owner tools are still planned.

T01/T02 source checks and iOS bundling passed. Physical iPhone tab switching,
large-text layout, and VoiceOver acceptance are still pending. Bundling alone
does not verify native rendering. Read [the handoff](vibe-plus/HANDOFF.md) before
starting a task and [the plan](vibe-plus/PLAN.md) for task boundaries.

## Local setup

Use Git, Node.js **24.3.0 or newer**, and npm **11 or newer**. The existing
checkpoint was checked with Node 24.19.0/npm 11.17.0. This is an npm workspace
with one root lockfile; install from the repository root.

On a fresh clone, in PowerShell:

```powershell
git clone https://github.com/rckycls/picklyph.git
cd picklyph
npm ci
Copy-Item -LiteralPath .env.example -Destination .env
npm start
```

If you already have the checkout, use that directory and preserve any existing
`.env` values. The fallback/tab UI works without credentials. To build the native
map, replace the Maps placeholder in an ignored `.env.local` and configure it in
the EAS development environment. Supabase values configure `getSupabase()` when
the auth provider starts; the current map does not request it. The
commented server section is a reference, not mobile configuration.

Open matching **Expo SDK 57** Expo Go on an iPhone, put the phone and computer on
the same Wi-Fi network, and scan Metro's QR code with the iPhone camera. Check
all three tabs and their navigation buttons, large text/scrolling, and VoiceOver
labels. Use the new development build for Google Maps and Apple/secure-session
acceptance; Expo Go does not verify this app's native configuration. Press
`Ctrl+C` to stop Metro.
If the iOS App Store version of Expo Go no longer supports SDK 57, use a matching
development build; do not change pinned dependencies just to suppress a mismatch.

Windows can serve Metro to an iPhone and submit cloud builds. A **local iOS
Simulator requires macOS/Xcode**; `npm run start:ios` is for that host, not Windows.
If PowerShell blocks the npm scripts, use `npm.cmd`/`npx.cmd` for these commands.

## Commands and checks

| Command | Purpose |
| --- | --- |
| `npm start` | Start Metro for Expo Go or an installed development client. |
| `npm run start:ios` | Start Metro and open a local iOS Simulator on macOS. |
| `npm run typecheck` | Check mobile TypeScript and the shared domain workspace. |
| `npm run lint` | Lint the mobile/domain/config source; fail on warnings. |
| `npm run test:discovery` | Run location permission/failure, demo release-gate, and build-configuration checks with Node's test runner. |
| `npm run test:directory` | Apply the migration and test spatial/role isolation in disposable embedded PostgreSQL/PostGIS, plus public client configuration checks. No Docker, hosted credentials or network requests. |
| `npm run test:directory:local` | Run the same rollback-only SQL suite against the local Docker Supabase database; requires the migrated local stack. |
| `npm run test:auth` | Check email/Apple contracts, secure-storage recovery and restoration/foreground lifecycle races. |
| `npm run test:auth:local` | Exercise new/returning email OTP, cold restoration, refresh and sign-out against local Docker Auth/Mailpit; removes its own fixtures. |
| `npm run check:dependencies` | Check the installed versions against the Expo SDK. |
| `npm run bundle:ios` | Export an iOS Hermes bundle to ignored `dist/ios`; does not create an installable `.ipa`. |
| `npx expo-doctor` | Check Expo project health; not a package script. |

Use `npm ci` for a clean install and `npx expo install <package>` when adding
Expo/native dependencies. Keep the SDK-compatible pins and the root lockfile.
After moving routes, restart Metro if generated `.expo/types` become stale;
keep typed navigation and strict TypeScript enabled.

## Configuration and secret boundaries

[`.env.example`](.env.example) is the committed reference. `.env`, `.env.local`,
other `.env.*` files, signing keys, and generated builds are ignored by Git.
Only the placeholder `.env.example` is allowed back into version control.

| Variable | Where to configure it | First use |
| --- | --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | Mobile `.env`; EAS environment for cloud builds. | Directory client, T05. |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Same staging project as the URL; mobile `.env`/EAS. | Directory client, T05. |
| `GOOGLE_MAPS_IOS_API_KEY` | Local native-build `.env` and EAS development environment. | Maps config plugin, T04. |
| `IOS_BUNDLE_IDENTIFIER` (optional) | Local/EAS build configuration; defaults to `com.rckycls.picklyph`. | Must match the Maps key restriction and Apple signing. |
| `EAS_PROJECT_ID` (optional) | Local/EAS build configuration; default project already linked in app config. | Use when intentionally changing the EAS project. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEYS` | Automatically injected in Supabase-hosted functions; do not set/override them. | Privileged server handlers; never the mobile app. |
| `PICKLYPH_SUPABASE_URL`, `PICKLYPH_SUPABASE_SECRET_KEY` | Optional reference names for other backend hosts; backend secrets or a separate ignored backend env file. | Server integrations outside hosted functions. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Backend hosting secrets or a separate ignored backend env file. | Server API rate limits, T13. |
| `GOOGLE_PLACES_SERVER_API_KEY` | Backend hosting secrets, with server/API restrictions. | Later owner address search. |

Expo inlines referenced `EXPO_PUBLIC_` variables into shipped JavaScript. Read
public values with dot notation, such as `process.env.EXPO_PUBLIC_SUPABASE_URL`.
Anything embedded in app code, native configuration, or `extra` can be read by
app users; dropping the prefix does not make an embedded value secret. Never
put Supabase secret/service-role keys, Upstash tokens, PayMongo secret keys, or
webhook secrets in those locations. [Expo environment-variable guide](https://docs.expo.dev/guides/environment-variables/)

A Supabase publishable key is intended for mobile clients. Database grants,
row-level security, and user authorization control access. Secret keys bypass
RLS and stay on the server. Use the publishable/secret key types for new setup.
A legacy `anon` key is public; a legacy `service_role` key is server-only.
[Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)

The native Maps key will ship in the iOS binary. Restrict it to the selected
bundle identifier and Maps SDK for iOS, and use a separate server key for Places.
[Google Maps key restrictions](https://developers.google.com/maps/api-security-best-practices)

Deploy custom server variables to the backend secret store, not EAS mobile
environments. Supabase reserves the `SUPABASE_` prefix and supplies its project
URL/keys to hosted functions; use the platform values there. Future local
function secrets belong in ignored `supabase/functions/.env`. The example's
custom names are references, not handlers already wired into this repo.
[Supabase function secrets](https://supabase.com/docs/guides/functions/secrets)
Upstash's REST URL/token are found in its database console; the app will call
guarded backend APIs rather than Redis directly.
[Upstash REST client configuration](https://upstash.com/docs/redis/howto/connect-with-upstash-redis)

Keep staging and production Supabase projects/Upstash databases separate and
match each deployment's URL/key/token set. Supabase remains authoritative for
inventory, holds, bookings, payments, and scheduled jobs; Redis is for server
request limits. Payment variables and provider activation gates are finalized
in T06 before checkout implementation.

## Windows to iPhone development builds (T04)

Native Maps/location dependencies, `expo-dev-client`, the config plugins, and
`eas.json` are now configured. The bundle identifier is `com.rckycls.picklyph`.
The EAS project is [@rckycls/picklyph](https://expo.dev/accounts/rckycls/projects/picklyph),
ID `c856cbf6-f323-41b7-9e1a-76ef6f5f2146`. The first development iOS build
[completed successfully](https://expo.dev/accounts/rckycls/projects/picklyph/builds/a74b7540-d5b7-4d06-b659-da5c22780f12)
on 2026-10-06, and the user confirmed the map works on the installed iPhone app.
Maps key/environment and device/signing setup are complete. The user confirmed
T04's required marker/detail, pan/recenter and permission-denial checks pass.
The checklist below is retained for future native builds and regression checks.

1. Prepare an Expo account, active Apple Developer Program membership, and a
   physical iPhone. The account/device readiness and bundle ID were confirmed
   for T04; verify the device is registered in EAS before building.
   Enable Maps SDK for iOS in a billing-enabled Google Cloud project and create
   the restricted iOS Maps key for that identifier. Use Developer Mode on the
   iPhone when installing a development build.
2. Put `GOOGLE_MAPS_IOS_API_KEY` in ignored `.env.local`. The Maps plugin reads it
   through `iosGoogleMapsApiKey`. iOS cloud builds reject missing/placeholder
   keys. Native changes require a new build.
   [Expo SDK 57 Maps setup](https://docs.expo.dev/versions/v57.0.0/sdk/map-view/)
3. Sign in and check the existing project link:

   ```powershell
   npx eas-cli@latest login
   npx eas-cli@latest project:info
   ```

   Its `eas.json` development profile uses `developmentClient: true`,
   `distribution: "internal"`, and `environment: "development"`.
4. Set the mobile public values and native Maps key in the EAS **development**
   environment. Use plaintext visibility for public values and sensitive
   visibility for the Maps key so local config evaluation can also access it.
   EAS visibility limits dashboard access; it does not hide an embedded key
   from app users. Ignored local `.env` files are not a substitute for EAS
   environment configuration. [EAS environment usage](https://docs.expo.dev/eas/environment-variables/usage/)
5. After configuration is complete, register the iPhone and submit the cloud
   build. Install the resulting build from EAS on that device, then serve Metro:

   ```powershell
   npx eas-cli@latest device:create
   npx eas-cli@latest build --platform ios --profile development
   npm start -- --dev-client
   ```

   Adding another device after a build may require updating provisioning and a
   new build or re-signing. EAS compiles iOS in the cloud; the development build
   is separate from the App Store Expo Go app and from later TestFlight delivery.
   [Expo iPhone cloud-build workflow](https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/)

On the installed development build, pan the map, select all three demo markers
and list entries, close the sheet, use location to recenter, and return to the
Philippines-wide view. Deny location and confirm browsing still works; test
disabled Location Services and returning from Settings after granting/revoking
access. Google attribution stays inside the unobstructed map area. These checks
require the device; Node tests and config introspection cannot substitute for them.
Demo locations are illustrative and not bookable; release mode exposes no demo
venues, and these fixtures are never backend seed data.

## Supabase directory foundation (T05)

The directory migration is
[`20261006030000_directory.sql`](supabase/migrations/20261006030000_directory.sql).
It keeps `public.venues` and `public.courts` limited to directory fields. Guests
and signed-in clients can read approved venues and their active courts; neither
can publish, claim or modify records. Claimant IDs and evidence paths live in
`private.venue_claims`, with no client privileges or policies. PostGIS is installed
in `extensions`, outside the exposed Data API schema.
[Supabase PostGIS guidance](https://supabase.com/docs/guides/database/extensions/postgis),
[grants and RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)

`venues_in_bounds` is an invoker-rights spatial primitive with validated bounds,
stable ID ordering and a 200-row maximum. It returns safe pin fields and applies
the caller's RLS. Full search/pagination/filter/rate-limit API work is T13/T14.
Directory/claim status alone never implies ownership authorization or bookability.
There are no schedules, inventory, booking/payment tables or production seeds.

[`packages/domain/src/`](packages/domain/src/index.ts) contains schema-maintained
public contracts, including the typed Supabase `Database`; these are not generated
from a hosted project. Compile-only checks verify RPC arguments, read result types
and exclusion of private tables/schema. `getSupabase()` uses only a hosted staging
URL and `sb_publishable_` key, initializes lazily, and persists native sessions
through SecureStore with foreground refresh. Missing configuration does not
break the demo map. See [T07 authentication setup](docs/auth-setup.md).

`npm run test:directory` creates an in-memory PostgreSQL 18.3/PostGIS 3.6 database
using dev-only PGlite packages. It supplies minimal platform roles and `auth.users`,
then applies the real migration and runs
[`directory.sql`](supabase/tests/directory.sql). The engine enforces SQL privileges,
RLS and spatial behavior; fixtures and test helpers roll back. This checks the
database foundation, not Supabase's Auth/REST services or the Docker PostgreSQL 17
stack. [PGlite PostGIS extension](https://pglite.dev/extensions/)

The user confirmed the mobile environment points to staging. Its public URL/key
are also configured in EAS development; no values are committed. No hosted
migrations or fixture data were applied. A staging SDK probe returned
`503 / PGRST002` (schema cache unavailable); confirm dashboard/database/API health
before connecting live screens. Docker Desktop's Linux engine is installed and
the migration and rollback-only SQL suite pass on local PostgreSQL 17.11 / PostGIS
3.3.7. Use the pinned CLI from this project:

```powershell
npx supabase start
npx supabase migration up --local
npm run test:directory:local
```

Local SDK smoke checks also pass for public venue/court reads, spatial RPC,
guest write denial, private-schema exclusion and Auth health. This verifies
directory API wiring. Local auth and authorization integration now pass too;
Storage workflows are later tasks.
Studio is available at http://127.0.0.1:54323 while the stack is running.
Use `npx supabase stop` to stop services while retaining local data.

The first startup downloads the local service images. `--local` keeps these
commands on the project database; use the SQL suite only on disposable databases.
The suite uses SQL assertions, not pgTAP. Its npm command streams SQL into the
`supabase_db_picklyph` container's `psql`, with `ON_ERROR_STOP=1`; the CLI's
`db query --file` cannot execute this multi-statement suite. Open a new terminal
after installing Docker so `docker` is available on PATH.

Local analytics is explicitly disabled in `supabase/config.toml`: the log
collector could not connect to the Windows per-user engine's TCP endpoint and
was restarting. Database, Auth, Storage and REST services remain available;
Studio's aggregated logs are unavailable with this setting. Container logs are
available in Docker Desktop. [Local analytics configuration](https://supabase.com/docs/guides/local-development/cli/config#analyticsenabled)

Hosted staging deployment needs separate CLI project access
and verified target selection; a mobile publishable key cannot apply migrations.
[Supabase CLI setup](https://supabase.com/docs/guides/local-development/cli/getting-started)

## Workspace and next steps

| Path | Responsibility |
| --- | --- |
| `src/app/` | Expo Router mobile routes. |
| `src/components/ui/` | Shared accessible controls and screen presentation. |
| `src/theme/`, `assets/brand/`, `docs/` | Concept C colors, typography, paddle-pin assets and setup notes. |
| `packages/domain/` | Shared TypeScript domain package. |
| `apps/admin/` (planned) | Next.js admin/moderator workspace with its own checks. |
| `supabase/` | Directory/authorization migrations, local configuration and SQL/API tests; Edge Functions later. |
| `vibe-plus/` | Task plan and current handoff. |

T04's native map and T05's embedded and Docker database checks pass. Hosted
staging deployment remains a separate setup step. Before T13,
prepare separate staging/production Upstash Redis databases near the backend
region. Begin PayMongo/venue onboarding alongside these tasks; T06 verifies
the supported payment flow and live activation requirements.

The current dependency audit reports 31 upstream advisories (21 high/10 moderate), including
the new Maps package's inherited React Native advisory chain. The suggested Maps
downgrade is outside the SDK 57 pin. Reassess supported upstream fixes before pilot;
do not apply a force fix that breaks native compatibility. This guide documents
development setup, not a production release acceptance.
