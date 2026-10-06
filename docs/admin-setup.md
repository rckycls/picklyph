# Admin console (T10–T11)

`apps/admin` is a separate Next.js 16 workspace for administrators and moderators.
It uses the Concept C palette, local Bricolage Grotesque fonts and the existing
paddle-pin mark. The root remains the Expo mobile app. Install from the root
with `npm ci`; one root lockfile covers both workspaces.

The console foundation has an email-code sign-in page, session-aware protected
workspace, access-denied/unavailable states and sign-out. T11 adds admin-only
venue/court editing, draft/publish/suspend controls and validated JSON imports.
See [directory curation](directory-curation.md) for setup, import format and
transaction boundaries. Auditing is T12; ownership review and a role editor are later.

## Configure and run

```powershell
Copy-Item -LiteralPath apps/admin/.env.example -Destination apps/admin/.env.local
# Edit apps/admin/.env.local locally with the chosen project's URL/publishable key.
npm run admin:dev
```

Do not overwrite an existing `.env.local`. Next reads the admin project's env,
independent of the root mobile env. Configure:

| Variable | Value |
| --- | --- |
| `ADMIN_ORIGIN` | Exact browser origin, e.g. `http://localhost:3000`; use the HTTPS console origin in hosting. Requests from other origins are rejected. |
| `ADMIN_SUPABASE_URL` | Chosen staging project URL, or `http://127.0.0.1:54321` for local Docker. HTTPS is required for remote projects. |
| `ADMIN_SUPABASE_PUBLISHABLE_KEY` | Same project's publishable key. Local CLI legacy `anon` keys are also accepted. Infrastructure/secret/service-role keys are rejected. |
| `ADMIN_SUPABASE_SECRET_KEY` | T11 only: same project's server-only secret (`sb_secret_`) key, or local legacy `service_role` key. Never expose via `NEXT_PUBLIC_` or Expo config. |

Open http://localhost:3000. Use the hostname in `ADMIN_ORIGIN` consistently;
`127.0.0.1` and `localhost` are different origins. Local development uses HTTP
cookies; production uses Secure cookies and must be served over HTTPS. No
service key or `NEXT_PUBLIC_` variables are needed for T10. Do not copy signing,
SMTP, payment or server secrets into browser configuration.

The selected Supabase project must have T05/T08 migrations and working Auth/REST;
T11 directory tools also need the curation migration and server-only secret key.
The local stack and hosted staging project `fkdusdurzdgbfwwigrqw` now have these
schemas. Hosted T05/T08 deployment completed on 2026-10-07; mobile and admin env
URLs were checked against that same target. Public directory reads and the bounds
RPC pass, and guest profile/access-RPC and private-schema requests are denied.
The Data API exposes only `public`; enabling it resolved the earlier PGRST002.
Public mobile settings cannot deploy migrations. Local CLI status prints service secrets too: capture JSON in memory
and copy only the URL/anon key, never paste full status output or keys into chat.

## Accounts and first administrator

The console sends codes only to **existing** Auth accounts (`shouldCreateUser:
false`). Use an account created in the mobile app or trusted project tooling.
Unknown accounts receive the same browser response; email availability/rate
errors are shown without exposing provider details. The configured OTP email
template must include `{{ .Token }}`. This code flow needs no callback URL or web
Apple OAuth secret; native Apple sign-in remains in the mobile app.

A signed-in player/venue owner gets an access-required screen. Grant the first
administrator through the trusted SQL bootstrap in
[account authorization](authorization.md#first-administrator), using the verified
project and intended Auth user UUID. No hosted user has been promoted. Subsequent
role-management commands must use verified server identity and actor-checked
SQL; T10 does not add a public bootstrap endpoint or a role editor.

## Security and request boundaries

- Each protected page and operation calls `auth.getUser()` for server-verified
  identity, then `my_account_access()` for current database assignments. It never
  trusts client actor IDs, signup metadata, role claims or `getSession()` for
  authorization. An account must currently hold `admin` or `moderator`.
- The shared guard supports an operation-specific required role. Being admitted
  to the console does not grant moderators administrative directory/role/refund
  powers. Admins also meet moderator-level access checks, matching T08's review
  permission hierarchy. T11 directory functions check and lock the admin assignment
  inside their transaction, preserving T08's verified actor boundary.
- A request-specific `@supabase/ssr` client stores the session in HttpOnly,
  SameSite=Lax, host-only cookies. Production adds Secure. Browser code receives
  no access/refresh tokens and does not create a browser Supabase client. The
  Next proxy refreshes cookies in request and response; it is not the access
  guard. Protected pages and APIs independently validate access.
- Pages use dynamic rendering; auth/protected responses have private/no-store
  caching. Do not place them behind public CDN caching or ISR. Revocation is
  checked on the next server request; an already rendered tab is not forcibly
  closed, and cannot use future protected operations after its role is removed.
- POST endpoints require the exact configured Origin and JSON auth input is
  bounded to 4 KiB. Auth retains Supabase's provider rate limits; the browser's
  resend wait is only UX. The planned Upstash business guard is T13.
- Sign-out revokes this browser session's refresh token and clears its cookies.
  It does not log out the mobile app. Keep TLS and the default security headers;
  no provider secrets/errors are logged by these handlers.

`POST /api/console/check-access` is a non-mutating foundation for testing and
reusing the server guard. It returns only the verified caller ID/current console
roles; ignores caller body actor/role assertions; returns 401 to guests, 403 to
regular/revoked users and 503 when verification/roles are unavailable. It grants
no additional database privileges.

## Verification

```powershell
npm run test:admin
npm run admin:typecheck
npm run admin:lint
npm run admin:build
npm run test:admin:local
npm run typecheck
npm run lint
npm run check:dependencies
```

The focused tests check verified identity, metadata denial, current-role
revocation, operation-specific role denial, failure handling, Origin protection,
bounded input and configuration boundaries. The local integration script requires
Docker/Supabase/Mailpit and a successful admin build. It starts its own production
Next server at `127.0.0.1:3100`, refuses a port already in use, passes local CLI
credentials only in memory and creates only its own random local accounts/mail.
It exercises real email codes, wrong/consumed-code recovery, forged-cookie denial,
real expired-session refresh with complete cache headers, cookie persistence, SSR
page/API allow-deny, forged actor/metadata denial, revocation and sign-out. It
removes its fixtures and stops only its child server; it never touches hosted
accounts. Production cookie headers are tested with a Node HTTP cookie jar;
that jar sends Secure cookies over loopback for the test, whereas browsers need
HTTPS in production.

These checks prove server behavior, not a browser screenshot or physical-device
layout review. Use dev mode for local browser layout, keyboard focus, narrow
viewport, wrong-code recovery and sign-out checks. No iPhone rebuild is required.
Vercel deployment, intended admin bootstrap, T11 hosted migration/secret setup
and hosted console email/browser acceptance remain operator steps. Hosted T05/T08
migrations and Data API checks passed on 2026-10-07; no new iPhone build is needed.

The root audit currently lists 34 upstream advisories (24 high/10 moderate).
Next's lint dependency chain adds affected package paths to the pre-existing
build-tool issues; no Next/Supabase runtime package is listed by this audit.
Keep the pinned supported versions and reassess upstream fixes before the pilot;
the suggested framework/native downgrades are not appropriate automatic fixes.

Sources: [Supabase cookie SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client),
[Supabase server verification/caching](https://supabase.com/docs/guides/auth/server-side/advanced-guide),
[Next.js authorization boundaries](https://nextjs.org/docs/app/guides/authentication).
