# HANDOFF: read this first

**Updated:** 2026-10-06, Asia/Manila. **Plan:** Codex desktop / ChatGPT Plus; keep configured model. W3 estimated 7 points, 6 accepted (T07 + T08). Capacity remains 8; no actual window-end/limit signal. A few sessions/week, experienced user, no deadline.

## Current state

- **T07 and T08 complete.** User explicitly confirms all T07 iPhone checks passed: Apple/email, sign-out, cold restore, foreground return/refresh, code recovery and guest/protected routes. H05 checked. T01/T03/T04/T05/T06 done; T02 navigation/large-text/VoiceOver review remains separate and unconfirmed.
- T08 migration 20261006090000_authorization.sql adds self-only profiles (only display_name editable), metadata-independent signup trigger/backfill, private admin/moderator assignments and verified venue links. my_account_access reads current DB roles/approved verified owned venues. Owner is venue-specific, not a global role.
- Role/owner assignment and management RPCs are service-only, with actor authorization. **Server derives actor_user_id from a verified token, never request JSON.** Protected role/owner tables are read-only even to service-role callers; mutations use actor-checked functions. Bootstrap first admin only in trusted SQL. Private helper checks must run inside later mutation transactions; a standalone preflight does not authorize a later write. See docs/authorization.md.
- Owners require a private link plus approved publication/verified claim state. Admins manage existing venues; moderators review ownership but cannot grant roles or automatically manage owner inventory. Revocation/suspension affects the next DB check. Evidence remains backend-only. No hosted user promoted, review interface, evidence approval or booking mutation added.
- **Evidence:** five embedded directory/client/authorization tests pass with real PostgreSQL/PostGIS grants, RLS, triggers and functions. Local Docker PostgreSQL17.11 SQL allow/deny suite and real SDK/API tests pass: profiles, ignored metadata, server-only command ACLs, role reads and ownership revocation. Own fixtures removed. Existing local email Auth integration still passes signup, verification, cold restore, refresh and sign-out after the new trigger. Mobile/domain typecheck and lint pass; T08 has no native runtime UI change.
- Local Supabase now has both T05 and T08 migrations, applied without reset. Docker Desktop WSL2/Linux stack remains running, analytics disabled (Vector log connection failed). Studio127.0.0.1:54323, Mailpit:54324; CLI2.119.0. Existing shells may need %LOCALAPPDATA%/Programs/DockerDesktop/resources/bin on PATH. CLI status/start prints secrets: capture/sanitize, never dump full JSON. Test scripts target local Docker/loopback and never read mobile env.
- **Hosted migrations not deployed.** Last directory REST probe was503/PGRST002; working Auth does not prove REST/schema health. Verify project/CLI access and health before hosted deployment. Mobile public settings cannot deploy schemas.

## Mobile and branding

- Expo57.0.26 / React19.2.3 / RN0.86.3 / Router57.0.24 / TS6.0.3 / Supabase-js2.117.2. Map opens first with labeled unverified development sample pins and optional foreground location. Bookings guarded by restored auth; search/live listings, inventory, payments and owner UI are later tasks.
- Concept C supersedes photo palette: blue#1E3F7C, yellow#D6F22E, court green#2E9A4B, deep green#1B7A3C, white. Lowercase pickly/tagline, Bricolage Grotesque Medium/SemiBold/ExtraBold, paddle-pin SVG/PNGs, branded markers and selected tabs implemented in c60a2d0. Font package0.4.1 / expo-font57.0.4 ship local assets; native font module already present. UI reloads through Metro; native icon needs next EAS binary. Brand/large-text device review remains separate.
- Completed iPhone build61c23f51-d806-4948-aae5-f903a5dc506a: https://expo.dev/accounts/rckycls/projects/picklyph/builds/61c23f51-d806-4948-aae5-f903a5dc506a. Bundle com.rckycls.picklyph, scheme picklyph; EAS @rckycls/picklyph, project c856cbf6-f323-41b7-9e1a-76ef6f5f2146. Apple capability/ad hoc profile fixed, existing cert reused. Map acceptedT04 and auth acceptedT07. T08 requires no reinstall/new binary.
- Auth remains sound: SecureStore device-only chunks/atomic manifests, race-guarded restoration, foreground refresh, local sign-out and request deadlines. Keep SDK default lockless coordination; processLock is deprecated. No secret keys in mobile/public env. Maps key ignored locally/EAS sensitive; public Supabase URL/key configured.
- Apple native flow needs no OAuth secret. Email SMTP/templates user-resolved; exact provider unverified, no domain. Do not repeat setup. Source records prior exempt-encryption answer ITSAppUsesNonExemptEncryption:false; reassess if release encryption changes.

## Next

1. **T09 when authorized:** PHP integer-centavo, UTC/Manila display and rental/horizon helpers. Full card in PLAN. No schedule/payment implementation. T08 contracts/helpers are ready for later admin/owner commands.
2. W4/T10 admin interface and verified server access; first admin bootstrap requires intended project/account selection. Claim/evidence orchestration isT15, action auditingT12. Hosted database deployment needs separate verified access.
3. Upstash separate staging/production needed beforeT13. T06 docs/payment-integration.md and H03 merchant/provider gates remain beforeT34; no provider messages, payment charges or payment code.

## Git and gotchas

- Main remote https://github.com/rckycls/picklyph.git. User reported pushing, but fetch/FETCH_HEAD on2026-10-06 confirmed remote main still bc0756f (T05), 9 commits behind local beforeT08. Discrepancy reported. Save T08 locally as T08: add account authorization; no push authorized this turn.
- Preserve private evidence and approved-only directory reads. Supabase owns transactional allocation/booking authority; Upstash is only rate limiting, no Redis inventory locks/QStash.
- Prior localhost preview declined: do not work around it or claim UI screenshots from bundling. Windows has no iOS simulator; native visual review needs physical iPhone.
- Audit remains31 upstream advisories (21high/10moderate); no force fixes, unsupported Maps downgrade, any/route casts or legacy-peer-deps.
- Do not infer usage reset from task acceptance. At an actual window end, log/recalibrate and expand next cards; retain reserved wrap-up.
