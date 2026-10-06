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
setup fallback instead. The live directory, search, sign-in,
reservations, payments, and owner tools are still planned.

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
the EAS development environment. Supabase values are unused until T05. The
commented server section is a reference, not mobile configuration.

Open matching **Expo SDK 57** Expo Go on an iPhone, put the phone and computer on
the same Wi-Fi network, and scan Metro's QR code with the iPhone camera. Check
all three tabs and their navigation buttons, large text/scrolling, and VoiceOver
labels and disabled sign-in announcements. Expo Go does not verify this app's
Google Maps build configuration. Press `Ctrl+C` to stop Metro.
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

## Workspace and next steps

| Path | Responsibility |
| --- | --- |
| `src/app/` | Expo Router mobile routes. |
| `src/components/ui/` | Shared accessible controls and screen presentation. |
| `src/theme/`, `docs/` | Photo-inspired semantic colors and brand notes. |
| `packages/domain/` | Shared TypeScript domain package. |
| `apps/admin/` (planned) | Next.js admin/moderator workspace with its own checks. |
| `supabase/` (planned) | Migrations, server functions, and database tests. |
| `vibe-plus/` | Task plan and current handoff. |

Before T04, complete H01 above. Before T05, prepare a Supabase staging project
and Docker for local testing or a disposable staging database. Before T13,
prepare separate staging/production Upstash Redis databases near the backend
region. Begin PayMongo/venue onboarding alongside these tasks; T06 verifies
the supported payment flow and live activation requirements.

T04 dependency audit reports 31 upstream advisories (21 high/10 moderate), including
the new Maps package's inherited React Native advisory chain. The suggested Maps
downgrade is outside the SDK 57 pin. Reassess supported upstream fixes before pilot;
do not apply a force fix that breaks native compatibility. This guide documents
development setup, not a production release acceptance.
