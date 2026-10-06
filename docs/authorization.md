# Account authorization (T08)

Players and verified owners use the same Supabase Auth account. An owner is
authorized for specific venues; there is no global `owner` role or client role
selector. Admin and moderator assignments are current database records, not
signup metadata, an email-domain heuristic or cached JWT role claims.

## Data and access

| Record | Access |
| --- | --- |
| `public.profiles` | A signed-in user reads their own row and edits only `display_name`. Other profiles are private. |
| `private.account_roles` | Protected admin/moderator assignments; clients cannot read or mutate this table. |
| `private.venue_owners` | Verified user-to-venue links; clients cannot read or mutate this table. |
| `private.venue_claims` | Existing private claim evidence remains backend-only. |
| `public.my_account_access()` | Signed-in caller's current privileged roles and approved, verified owned venue IDs. No target-user argument. |

The auth-user insert trigger creates a profile with a null display name and
ignores all user metadata, including malformed name data. Migration backfills
existing users. Display names are nullable or trimmed 1–80 characters. Profile
IDs, timestamps and grants are not editable by mobile users. Auth deletion
cascades the profile, role assignments and ownership links.

Every new table has RLS plus explicit grants. Private tables have no client
policies, so accidental future table grants still reveal no rows. Functions
use an empty search path and qualified relations; default `PUBLIC` execute
privileges are revoked explicitly.

## Trusted server commands

The following RPCs are executable only with server infrastructure credentials:

| Function | Application authorization |
| --- | --- |
| `set_account_role(actor_user_id, target_user_id, assigned_role, enabled)` | Actor must have a current admin assignment. Moderator cannot elevate roles. |
| `set_verified_venue_owner(actor_user_id, target_venue_id, owner_user_id, enabled)` | Actor must be admin/moderator. Adding a link requires the venue to already be verified. |
| `authorize_venue_management(actor_user_id, target_venue_id)` | Actor must be an admin or the verified owner of that approved venue. Missing venues and unauthorized actors are denied. |

**The server must verify the user's token and derive `actor_user_id` from that
verified identity. Never accept it from request JSON.** The service role grants
infrastructure access; it does not prove that the human actor is an admin.
Protected role/owner tables are read-only to service-role callers; their writes
go through the actor-checked functions. Trusted SQL operators can bootstrap.

Private SQL helpers `has_account_role`, `can_review_venues`,
`is_verified_venue_owner` and `can_manage_venue` support later commands. Future
mutating SQL commands must check authorization **inside their transaction**;
do not call a guard RPC and then assume a later write is authorized. The public
guard is a foundation/preflight check, not an inventory or booking mutation.

Owners require both a private link and an approved venue with `claim_status =
'verified'`. A pending claim, verified public badge, stale JWT or a link to a
draft/suspended venue grants no owner-management access. Revocation and venue
suspension affect the next database authorization check. Admins can manage any
existing venue; moderators can review ownership but get no automatic owner
management scope. Moderators/admins still use server operations for evidence.

T15 will perform evidence review and ownership-assignment orchestration; this
migration does not approve evidence, upload files, publish directory records,
edit court inventory or implement bookings. T10 adds the admin interface.

## First administrator

Create/sign in to the intended Auth account first. In trusted project SQL only,
replace the placeholder with its actual Auth user UUID:

```sql
insert into private.account_roles(user_id, role)
values ('REPLACE_WITH_AUTH_USER_UUID'::uuid, 'admin')
on conflict (user_id, role) do nothing;
```

This is an operator bootstrap, never a public signup endpoint. No hosted user
has been promoted by this task. No admin/service key belongs in Expo env.

## Verification and deployment

```powershell
npm run test:directory
npm run typecheck
npm run lint
npx supabase migration up --local
npm run test:authorization:local
npm run test:auth:local
```

The embedded suite uses disposable PostgreSQL/PostGIS with real grants, RLS,
triggers and functions. It verifies profile backfill/signup, metadata spoofing,
self/other profile access, column protection, server/actor permissions, owner
scope, assignment retries, revocation, suspension, evidence isolation and
defense against accidental read/write grants. The same rollback-only SQL runs
on the local Docker stack. Real local SDK/API checks create only their own
random fixture accounts/venue, verify profile privacy, ignored metadata,
server-only command ACLs, current role reads and ownership revocation, then
remove those fixtures. Local CLI credentials stay in memory and loopback
project/engine checks prevent hosted execution. Existing auth integration verifies signup,
email codes, restore, refresh and sign-out after installing the trigger.

Hosted deployment still requires verified project/CLI access. Mobile settings
do not deploy migrations. No new app binary is needed for this database work;
the current phone UI does not yet query these new tables/functions.

Sources: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[Auth profiles and triggers](https://supabase.com/docs/guides/auth/managing-user-data),
[database function security](https://supabase.com/docs/guides/database/functions).
