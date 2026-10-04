# HANDOFF: read this first

**Updated:** 2026-10-05, Asia/Manila. **Window:** W1 of an estimated 16. **Capacity:** 8 points; plan 7 plus reserved wrap-up. **Tool/plan:** Codex desktop, ChatGPT Plus. **Availability:** a few sessions/week; 3 assumed. **Experience:** experienced. **Deadline:** none.

## Where we are
- Last finished: T01 · Expo mobile workspace and themed welcome screen. Commit message: `T01: scaffold mobile workspace`.
- App state: Expo SDK 57.0.26 / React 19.2.3 / React Native 0.86.3; Expo Router uses `src/app/`. No backend or native map yet.
- Workspace: mobile app at root, `@picklyph/domain` under `packages/domain/`, reserved `apps/*` for admin. One root npm lockfile; Node >=24.3/npm >=11.
- Existing palette/docs preserved: `src/theme/colors.ts`, `docs/brand-colors.md`, `docs/color-palette.svg`.
- Theme: blue #466E9E, green #4EA473, lime #E5FC35, navy #14264D, white #FFFFFF. Text pairs checked at 4.5:1 or better.
- Git: initial implementation checkpoint on `codex/t01-mobile-workspace`; preserve existing assets.
- Checks passed: `npm ci`, `npm run typecheck` (mobile/domain), `npm run lint`, `npm run check:dependencies`, Expo Doctor 21/21, `npm run bundle:ios` (Hermes bundle in ignored `dist/ios`).
- Device evidence: no physical iPhone test yet. To test locally, run `npm start` and open with matching SDK 57 Expo Go on an iPhone; `start:ios` requires a macOS simulator host.

## Next up
1. T02 · Branded controls/navigation: full card and kickoff in PLAN.md > W1.
2. T03 · Environment setup and README.
- Keep the mobile app at root; reserve apps/admin and packages/domain. Use Expo-compatible versions and the saved semantic theme.
- W1 checkpoint: 4/7 task points done; T02/T03 remain. Capacity not recalibrated until window check-in. User authorized T01 only.

## Gotchas
- iOS-first from Windows: actual native Google Maps testing requires EAS build setup and a physical iPhone; no claim of device verification from a Metro bundle alone.
- Google provides the basemap. PicklyPH owns its directory; owners drop venue pins and submit for review. Do not build custom map infrastructure.
- Stack update: Supabase remains authoritative for all booking/payment data, holds, locks, and scheduled jobs. Add server-only Upstash Redis API rate limits in T13; no Redis inventory locks or QStash. Public directory caching is deferred until justified. Redis outages block new holds/checkouts, while cancellation and provider webhooks remain processable.
- Online payment and venue settlement require PayMongo activation/relationships; T06 checks API compatibility and refund funding. Keep online payments in MVP, but gate live enablement on provider readiness.
- Later windows are intentionally one-liners. Expand only the upcoming window into full cards at check-in/resume using real file paths learned so far.
- Capacity and session count are estimates; do not infer actual account limits or reset times from them.
- npm's optional peer resolution selected unsupported animation versions initially; explicit SDK-57 pins fixed it. The interrupted first install left missing files; clean `npm ci` restored them. Do not mask dependency failures with `any` declarations or `--legacy-peer-deps`.
- Upstream audit follow-up: 30 advisories (20 high/10 moderate), including unpatched braces <=3.0.3 and node-forge <=1.4.0, plus Router decoding/uuid chains. No force fix or incompatible Expo downgrade applied. Reassess supported upstream fixes before pilot; this checkpoint is for development.

## Waiting on the human
- H01–H03 during first cooldown: iPhone/Apple/Expo/Google setup, Supabase projects, payment provider/merchant onboarding; H02 also covers Upstash Redis databases/secrets before T13. See PLAN.md for exact prerequisites.
- Optional AGENTS.md startup rule has not been added; the skill requires offering it first.

## Uncommitted or half-done
- No half-done application task; T01 source, lockfile, existing theme/docs, and planning files are included in the initial commit. Generated dependency/build files stay ignored.
- Plan: continue with T02 in a fresh task chat. Keep admin code excluded from mobile TypeScript/lint; the admin workspace will get its own checks in T10.
- At window end, log results, tick tasks, recalibrate, refresh this handoff, expand next-window cards, and commit. Keep this file under about 40 lines.
