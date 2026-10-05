# PicklyPH

An iOS-first pickleball court finder and venue manager for the Philippines.
Players will discover courts, rent a court, or join group open play. Verified
owners will pin and manage venues through the same account.

## Current state

The Expo app opens on Discover, with Bookings and Account tabs and shared branded
controls. Search and sign-in are labeled as coming soon. The native map,
directory, authentication, reservations, payments, and owner tools are planned;
the app currently requires no credentials and makes no service calls.

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
`.env` values. Copying the template is optional for the current shell. When the
integrations are added, replace its mobile/build placeholders with staging
values. The commented server section is a reference, not mobile configuration.

Open matching **Expo SDK 57** Expo Go on an iPhone, put the phone and computer on
the same Wi-Fi network, and scan Metro's QR code with the iPhone camera. Check
all three tabs and their navigation buttons, large text/scrolling, and VoiceOver
labels and disabled search/sign-in announcements. Press `Ctrl+C` to stop Metro.
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

This is the upcoming setup workflow, not a build already configured by T03.
The repo has no `expo-dev-client`, `eas.json`, iOS bundle identifier, EAS project
link, or Maps plugin yet. H01 supplies the accounts/device/key; T04 adds the
native dependencies and configuration. Google Maps acceptance must use the
app's own iPhone development build with its configured key.

1. Prepare an Expo account, active Apple Developer Program membership, and a
   physical iPhone. Choose the app's unique iOS bundle identifier for T04.
   Enable Maps SDK for iOS in a billing-enabled Google Cloud project and create
   the restricted iOS Maps key for that identifier. Use Developer Mode on the
   iPhone when installing a development build.
2. During T04, set that identifier in `app.config.ts`, install `expo-dev-client`
   and the map/location dependencies using Expo-compatible versions, and wire
   `GOOGLE_MAPS_IOS_API_KEY` to the Maps plugin's `iosGoogleMapsApiKey` option.
   Native changes require a new build. [Expo SDK 57 Maps setup](https://docs.expo.dev/versions/v57.0.0/sdk/map-view/)
3. Link/configure the project during T04:

   ```powershell
   npx eas-cli@latest login
   npx eas-cli@latest init
   npx eas-cli@latest build:configure --platform ios
   ```

   Its `eas.json` development profile will use `developmentClient: true`,
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

T01 recorded 30 upstream npm advisories (20 high/10 moderate). Reassess supported
upstream fixes before pilot; do not apply a force fix that downgrades Expo or
breaks native compatibility. This guide documents development setup, not a
production release acceptance.
