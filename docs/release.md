# Release environments and checks (T50b)

T50b separates staging from production on the repo side. EAS build profiles choose a backend, the
build worker refuses an app that would ship the wrong backend or a server key, and one offline
command checks everything else before a build, a migration push or a function deploy. Creating the
production project, its secrets and the TestFlight build is T50 (operator steps, listed at the end).

## Environments

| App variant | EAS profile and environment | Backend | Distribution | JavaScript | Push entitlement |
| --- | --- | --- | --- | --- | --- |
| `development` | `development` | staging | internal dev client | served by Metro from the dev machine | development |
| `preview` | `preview` | staging | internal (ad hoc, registered iPhones) | embedded at build time | production |
| `production` | `production` | production | store (TestFlight, then App Store) | embedded at build time | production |

- `eas.json` sets `APP_VARIANT` for each profile; nothing else sets it. Metro, tests and `expo export`
  default to `development`.
- [`release/environments.json`](../release/environments.json) maps each variant to a backend and records
  each backend's Supabase project ref. Refs are public (they ship in the app). **Production's ref is
  `null` until T50 creates the project**, so production builds and checks fail until it is recorded.
- All variants keep the bundle identifier `com.rckycls.picklyph`. Apple's Sign in with Apple and push
  capabilities, the Supabase Apple client ID, the iOS Maps key restriction and staging's
  `APPLE_CLIENT_ID` are all tied to it. As a result only one variant is installed on a phone at a
  time. Installing another replaces it; recovery journals are keyed by backend and account, so
  switching is safe.
- Build numbers are managed remotely by EAS (`cli.appVersionSource: "remote"`). Production builds
  auto-increment. The first build after this change starts from 1, because app config sets no
  `buildNumber`. If a build was already uploaded to App Store Connect, run
  `npx eas-cli@latest build:version:set` first. Bump the marketing `version` in `app.config.ts` by hand
  for each App Store release.
- `expo-notifications` writes `aps-environment`: `development` for dev clients and `production` for ad
  hoc and store builds, because those builds receive pushes through Apple's production gateway.

## EAS environment variables

Set these three in each EAS environment (`development`, `preview`, `production`). Use the staging
project's values for development and preview, and the production project's values for production.
Never put a server setting in an EAS mobile environment.

| Name | Visibility | Notes |
| --- | --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | plain text | `https://<ref>.supabase.co` of the variant's backend |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | plain text | `sb_publishable_…` of the same project (legacy `anon` keys are accepted if their `ref` matches) |
| `GOOGLE_MAPS_IOS_API_KEY` | sensitive | restricted to `com.rckycls.picklyph` and Maps SDK for iOS; a separate production key makes quota and rotation independent |

Secret visibility would hide a value from `eas env:pull` and so from `release:check`. These three values
end up in the app anyway.

## What an EAS build refuses

`app.config.ts` runs `checkMobileEnvironment` (`scripts/release/environment.cjs`) on every EAS build
worker (`EAS_BUILD_PLATFORM` set). It stops the build, listing every problem by name, when:

- the Maps key is missing or a placeholder (all variants; the earlier T04 message still comes first on iOS);
- an `EXPO_PUBLIC_` variable is named like a server setting (`SECRET`, `SERVICE_ROLE`, `PRIVATE`,
  `TOKEN`, `PASSWORD`) or holds a Supabase secret key, a private key or a non-`anon` JWT (all variants);
- preview/production only: the backend's ref is unrecorded or shared with another backend; the URL is
  not `https://<ref>.supabase.co`; the URL or a legacy key points at another project (named, e.g.
  "fkdusdurzdgbfwwigrqw, the staging project"); the key is missing or is not a publishable key.

Development builds skip the backend rules, because their JavaScript comes from Metro and the dev
machine's `.env.local` at run time, not from the build.

## Release check

`npm run release:check -- --variant <development|preview|production> <checks>` runs only the checks
you name. It prints setting names and project refs, never values, and exits 1 on any problem (2 for a
usage error). Keep the inputs in ignored places: `.env.*` files or `dist/`.

**App values** (before an EAS build). `.env.eas.<environment>` is ignored by git and not loaded by Expo,
unlike `.env.production.local`, which `expo export` would pick up:

```powershell
npx eas-cli@latest env:pull --environment production --path .env.eas.production
npm run release:check -- --variant production --env-file .env.eas.production
Remove-Item .env.eas.production
```

**Bundle scan** (after an export or a build). It reads `.hbc`, `.jsbundle`, `.js`, `.json`, `.map` and
`.txt` files and reports: the other backend's ref (also inside legacy JWT keys), a missing URL for the
expected backend, server setting names, Supabase secret keys, private keys, Upstash addresses and
non-`anon` JWTs. `npm run bundle:ios` uses `.env.local` (staging), so check its export as `preview`. To
check what actually ships, download the build's `.ipa` from EAS and scan it unzipped:

```powershell
npm run release:check -- --variant preview --bundle dist/ios
New-Item -ItemType Directory -Force dist/ipa
tar -xf PicklyPH.ipa -C dist/ipa
npm run release:check -- --variant production --bundle dist/ipa
```

**Function secrets** (after setting them, before relying on them). Supabase lists only the SHA-256
digest of each value, and the check compares those digests. It needs every required name, checks that
`PICKLY_ENV` equals the backend name, that `DISCOVERY_SUPABASE_URL` is the backend's own
`https://<ref>.supabase.co` (with or without a trailing slash) and that `APPLE_CLIENT_ID` is the bundle
identifier. It refuses environment-scoped settings that are identical in both lists, and two lists from
the same project. Values with stray whitespace or a trailing newline will not match.

```powershell
npx supabase secrets list --project-ref <production ref> -o json > dist/secrets.production.json
npx supabase secrets list --project-ref fkdusdurzdgbfwwigrqw -o json > dist/secrets.staging.json
npm run release:check -- --variant production --secrets dist/secrets.production.json --compare dist/secrets.staging.json
```

The text table that `secrets list` prints without `-o json` is accepted too, and so are the UTF-16
files that Windows PowerShell 5.1 redirection writes.

**Linked project** (before `supabase db push` or `supabase functions deploy`). The Supabase CLI's
linked project (`supabase/.temp/linked-project.json`) must be the variant's backend:

```powershell
npm run release:check -- --variant production --linked
```

## Function secrets

| Name | Used by | Per environment? |
| --- | --- | --- |
| `DISCOVERY_SUPABASE_URL`, `DISCOVERY_SUPABASE_PUBLISHABLE_KEY`, `DISCOVERY_SUPABASE_SECRET_KEY` | every function | yes: the environment's own project |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | rate guard (`_shared/upstash.ts`) | yes: separate Redis databases (H02) |
| `RATE_LIMIT_KEY_SECRET` | rate-limit identifier HMAC, 32+ characters | yes |
| `PICKLY_ENV` | rate-limit namespace: `staging` or `production` | yes |
| `PUSH_WORKER_SECRET` | `push-dispatch`; the same value in Vault `push_worker_secret` | yes |
| `GOOGLE_MAPS_SERVER_API_KEY` | `owner-submissions` geocoding (Geocoding API only) | may be shared |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_CLIENT_ID`, `APPLE_PRIVATE_KEY` | `account-deletion` (T50a) | may share the Apple key; client ID is the bundle ID |
| `OPS_MONITOR_SECRET` | `ops-monitor` (T51a); the same value in Vault `ops_monitor_secret` | yes |
| `OPS_ALERT_WEBHOOK_URL` | `ops-monitor`: the operators' Discord channel webhook | may be shared (messages name the environment) |
| `OPS_HEARTBEAT_URL` (optional) | `ops-monitor`: outside dead-man's switch pinged after each run | must differ when set in both |
| `EXPO_ACCESS_TOKEN` (optional) | `push-dispatch`, only with Expo enhanced push security | may be shared |
| `DISCOVERY_IP_SOURCE` (optional) | `venue-search`; `cloudflare` only after the H02 header checks | not checked |

## T50 operator steps

1. Create the production Supabase project, record its ref in `release/environments.json` (commit it),
   and `supabase link` to it. From then on, a preview check fails while the CLI is linked to production,
   and a production check fails while it is linked to staging.
2. Auth: Apple (native, bundle ID as client ID), email codes and SMTP as in
   [auth-setup.md](auth-setup.md#staging-setup). Expose the `public` API schema (the staging
   `PGRST002` fix in HANDOFF).
3. `release:check --variant production --linked`, then `supabase migration list`,
   `supabase db push --dry-run` and `supabase db push`. No seeds.
4. Production Upstash database (H02). Set the function secrets above, then run the secrets check
   against staging's list.
5. Deploy the twelve functions in `supabase/config.toml` (`verify_jwt = false`, import map). Then set up
   pg_net, Vault and the cron jobs (`booking-expiry-sweep`, `privacy-retention-sweep`, `push-dispatch`,
   `ops-monitor`) as in [notifications.md](notifications.md#rollout-and-operator-steps),
   [privacy.md](privacy.md#rollout-and-operator-notes) and
   [monitoring.md](monitoring.md#setup-per-environment-operator); check that the first monitor post
   arrives in the Discord channel.
6. Assign the first administrator by trusted SQL ([authorization.md](authorization.md#first-administrator)).
7. Set the EAS `production` variables and check them with `--env-file`. Add an APNs key
   (`eas credentials`) and create the App Store Connect app (optionally add its `ascAppId` to
   `submit.production` in `eas.json`).
8. `npx eas-cli@latest build --platform ios --profile production`, scan the downloaded `.ipa`, then
   `npx eas-cli@latest submit --platform ios --profile production` for TestFlight.

Testers who should stay on staging get `preview` builds: their iPhones must be registered
(`eas device:create`), and the EAS `preview` environment needs the three staging values first.
