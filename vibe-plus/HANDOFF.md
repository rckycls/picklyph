# HANDOFF: read this first

**Updated:** 2026-10-05, Asia/Manila. **Window:** W1 of an estimated 16. **Capacity:** 8 points; plan 7 plus wrap-up. **Tool/plan:** Codex desktop, ChatGPT Plus. **Availability:** a few sessions/week; 3 assumed. **Experience:** experienced. **Deadline:** none.

## Where we are
- Last finished: T03, committed as `T03: document environment setup`. T01 finished; T02 code/checks complete, but its checkbox stays open pending iPhone acceptance.
- App: Expo SDK 57.0.26 / React 19.2.3 / React Native 0.86.3. Discover opens first, with Bookings/Account under `src/app/(tabs)/`. UI only; no service calls, native map, authentication, or reservations yet.
- UI: `src/components/ui/` has Button, Card, Field, StatusBadge, Screen, CourtArtwork, TabIcon; focus/pressed/disabled/loading/error states, safe-area scrolling and font-scale-aware tabs. Search/sign-in explicitly unavailable; buttons navigate.
- Workspace: root mobile, `packages/domain/`, reserved `apps/*` for admin; root npm lockfile, Node >=24.3/npm >=11. Theme/docs preserved: blue #466E9E, green #4EA473, lime #E5FC35, navy #14264D, white #FFFFFF.
- T03: README covers actual scripts, optional local env setup, Expo Go and future Windows-to-iPhone EAS setup. Root `.env.example` activates only public Supabase URL/publishable key and the native Maps key; server references stay commented. No real credentials or app/dependency changes.
- T03 checks passed: placeholder-only values, 3 active mobile/build variables, all package scripts/README file links valid, 8 private env paths ignored, template allowed, no tracked private env files. Existing ignore rules suffice.
- Prior checks: mobile/domain typecheck, lint, iOS bundle (1114 modules), 11 text contrasts >=4.95:1; T01 clean install/dependency check/Expo Doctor 21/21. Native acceptance remains separate.
- Git: `main` tracks `origin/main` at https://github.com/rckycls/picklyph.git. T01/T02/Expo sync pushed; T03 committed locally.
- No iPhone evidence yet. Browser review denied localhost preview; no UI interaction/screenshot check claimed. Temporary preview server stopped.

## Next up
1. T02 acceptance: run `npm start` on the computer, open matching SDK 57 Expo Go on iPhone, switch tabs/follow buttons, test large text/scrolling and VoiceOver labels/disabled states. Tick T02 only after that passes.
2. H01 before T04: Expo/Apple accounts, iPhone, chosen bundle identifier, restricted iOS Maps key. T04 then adds native dependencies, EAS/config plugin wiring and the actual Google map.
3. H02 before T05: Supabase staging/production and Docker or disposable staging SQL access. H03 begins provider/venue onboarding for T06 and later payments. W2 full cards already exist.
- W1: 5/7 accepted points, all 7 implemented; T02's 2 await device acceptance. No window-end/usage-limit signal; capacity unchanged. User authorized T03; T04 has not started.

## Gotchas
- Root env values are unused by the current shell. T04 wires `GOOGLE_MAPS_IOS_API_KEY`; T05 wires `EXPO_PUBLIC_SUPABASE_URL`/`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Native Maps keys ship in the binary: restrict bundle/API usage.
- Server secrets never enter root mobile env, Expo public variables, app `extra`, or native config. Hosted functions inject `SUPABASE_URL`/`SUPABASE_SECRET_KEYS`; the `SUPABASE_` prefix is reserved. Optional other-host examples use `PICKLYPH_SUPABASE_URL`/`PICKLYPH_SUPABASE_SECRET_KEY`. Upstash REST URL/token live in backend secrets.
- Windows supports Metro/cloud EAS submission; local iOS Simulator requires macOS. Actual native Google Maps acceptance needs the app's own physical iPhone development build; no `eas.json`, dev client, Maps plugin or bundle identifier is configured yet.
- Google supplies the basemap; PicklyPH owns reviewed venue data/pins. Supabase owns inventory/holds/payments/jobs; T13 adds server-only Upstash API guards, no Redis locks/QStash. Redis outages block new holds/checkouts, while cancellation/webhooks remain processable.
- Online payment live activation depends on PayMongo/provider readiness; T06 verifies marketplace APIs/refund funding. Keep full MVP payment scope.
- Restart Metro after route moves if generated typed routes become stale; do not cast paths/disable strict typing. T01 dependency failures were resolved by SDK-57 pins and clean `npm ci`; do not use `any` shims or `--legacy-peer-deps`.
- Existing audit follow-up: 30 upstream advisories (20 high/10 moderate), including unpatched braces/node-forge and Router/uuid chains. No force fix/downgrade; reassess supported fixes before pilot.
- Expand later cards only just before their window. Estimates do not imply actual account limits/reset times.

## Waiting on the human
- T02 iPhone acceptance; T01 device rendering also unverified. H01–H03 account/device/provider setup (PLAN.md), with Upstash databases before T13.
- Optional AGENTS.md startup rule remains unadded; offer before adding.

## Uncommitted or half-done
- T03 docs/template/planning committed; no half-done code or pending source changes. Generated dependency/build/env files ignored.
- At window end, log results, tick verified tasks, recalibrate, refresh handoff, expand upcoming cards, and commit.
