# HANDOFF: read this first

**Updated:** 2026-10-05, Asia/Manila. **Window:** W1 of an estimated 16. **Capacity:** 8 points; plan 7 plus reserved wrap-up. **Tool/plan:** Codex desktop, ChatGPT Plus. **Availability:** a few sessions/week; 3 assumed. **Experience:** experienced. **Deadline:** none.

## Where we are
- T01 finished; T02 implementation committed as `T02: add branded app controls`, with device acceptance pending. PLAN.md keeps T02 unchecked until that check passes.
- App: Expo SDK 57.0.26 / React 19.2.3 / React Native 0.86.3. Discover is the initial tab, with Bookings and Account under `src/app/(tabs)/`; no map/backend yet. Root welcome route replaced with Discover; court artwork reused.
- UI: `src/components/ui/` contains Button, Card, Field, StatusBadge, Screen, CourtArtwork, and TabIcon. Buttons support focus/pressed/disabled/loading; fields support labels/hints/errors/focus/disabled. Safe-area scrolling and font-scale-aware tab sizing included. Search/sign-in explicitly unavailable; buttons navigate between tabs.
- Workspace: mobile app at root, `@picklyph/domain` under `packages/domain/`, reserved `apps/*` for admin. One root npm lockfile; Node >=24.3/npm >=11.
- Existing palette/docs preserved: `src/theme/colors.ts`, `docs/brand-colors.md`, `docs/color-palette.svg`.
- Theme: blue #466E9E, green #4EA473, lime #E5FC35, navy #14264D, white #FFFFFF. Text pairs checked at 4.5:1 or better.
- Git: `main` tracks `origin/main` at https://github.com/rckycls/picklyph.git. T01/README, T02, and the Expo configuration sync are committed on `main`; the user authorized publishing this checkpoint.
- T02 checks passed: mobile/domain typecheck, lint, iOS bundle (1114 modules), and 11 text contrast pairs (minimum 4.95:1). No dependency changes. T01 clean install, dependency check and Expo Doctor 21/21 previously passed.
- Device evidence: no physical iPhone test. Browser permission review rejected localhost access as declined; no interaction/screenshot check claimed. Use matching SDK 57 Expo Go on iPhone; `start:ios` requires macOS.

## Next up
1. T02 acceptance: run `npm start` on the computer and open it in Expo Go on an iPhone. Switch all three tabs, follow navigation buttons, check large text/scrolling, and use VoiceOver to confirm labels and disabled search/sign-in announcements. Tick T02 only when that passes.
2. T03 · Environment setup/README can proceed independently while awaiting the device check.
- Keep the mobile app at root; reserve apps/admin and packages/domain. Use Expo-compatible versions and the saved semantic theme.
- W1: 4/7 accepted task points; 2 more implemented with device acceptance pending, 1 unstarted. No capacity recalibration until window check-in. User authorized T02 and committing/pushing current changes; T03 remains unstarted.

## Gotchas
- Expo typed-route cache briefly contained stale/misclassified paths during file moves. Restarting `expo start` regenerated correct routes; do not cast paths or disable strict types to mask cache errors. Temporary preview server stopped after checks.
- iOS-first from Windows: actual native Google Maps testing requires EAS build setup and a physical iPhone; no claim of device verification from a Metro bundle alone.
- Google provides the basemap. PicklyPH owns its directory; owners drop venue pins and submit for review. Do not build custom map infrastructure.
- Stack update: Supabase remains authoritative for all booking/payment data, holds, locks, and scheduled jobs. Add server-only Upstash Redis API rate limits in T13; no Redis inventory locks or QStash. Public directory caching is deferred until justified. Redis outages block new holds/checkouts, while cancellation and provider webhooks remain processable.
- Online payment and venue settlement require PayMongo activation/relationships; T06 checks API compatibility and refund funding. Keep online payments in MVP, but gate live enablement on provider readiness.
- Later windows are intentionally one-liners. Expand only the upcoming window into full cards at check-in/resume using real file paths learned so far.
- Capacity and session count are estimates; do not infer actual account limits or reset times from them.
- npm's optional peer resolution selected unsupported animation versions initially; explicit SDK-57 pins fixed it. The interrupted first install left missing files; clean `npm ci` restored them. Do not mask dependency failures with `any` declarations or `--legacy-peer-deps`.
- Upstream audit follow-up: 30 advisories (20 high/10 moderate), including unpatched braces <=3.0.3 and node-forge <=1.4.0, plus Router decoding/uuid chains. No force fix or incompatible Expo downgrade applied. Reassess supported upstream fixes before pilot; this checkpoint is for development.

## Waiting on the human
- T02 iPhone acceptance above; T01 device rendering also remains unverified.
- H01–H03 during first cooldown: iPhone/Apple/Expo/Google setup, Supabase projects, payment provider/merchant onboarding; H02 also covers Upstash Redis databases/secrets before T13. See PLAN.md for exact prerequisites.
- Optional AGENTS.md startup rule has not been added; the skill requires offering it first.

## Uncommitted or half-done
- T02 source/planning and the pre-existing Expo-generated `.gitignore`/`expo-env.d.ts` changes are committed; no half-done code or pending source changes. Dependencies/build output stay ignored.
- Next implementation: T03 in a fresh task chat. Keep admin excluded from mobile TypeScript/lint; it gets separate checks in T10.
- At window end, log results, tick tasks, recalibrate, refresh this handoff, expand next-window cards, and commit. Keep this file under about 40 lines.
