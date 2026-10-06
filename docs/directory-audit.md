# Directory audit (T12)

`supabase/migrations/20261007060000_directory_audit.sql` adds
`private.directory_audit_events` and auditing for the existing T11 commands.
Apply after T11. This task applies it locally; hosted staging remains on T05/T08.

Each successful save or publication command appends one event in its database
transaction. A venue save covers the venue and its submitted court changes.
The record contains only a decimal-string event ID, verified actor UUID,
target venue UUID, fixed action, and database `clock_timestamp()` as UTC
`timestamptz`. No names, addresses, request bodies, source references, private
evidence, contacts, credentials or before/after snapshots are copied.

| Command | Action |
| --- | --- |
| Create draft | `directory.create` |
| Save existing venue/courts | `directory.update` |
| Publish approved | `directory.publish` |
| Return to draft | `directory.unpublish` |
| Suspend | `directory.suspend` |
| Import new venue | `directory.import` |

Imports append one event per newly created venue. Identical retries return
`existing` and append nothing. A later conflict rolls back earlier writes and
events in that batch. A successfully accepted save/publication records an event
even when the submitted values equal current values; it records the command.
Failed validation, stale versions, permission denial and enclosing transaction
rollback leave no successful event. An audit insert failure aborts the command
and rolls back its directory changes.

The proven T11 save/publication implementations move into the private schema,
without client/service execution grants. Audited public wrappers are service-only.
Imports use the private save implementation and append their own import event.
Authorization and its transaction-held role lock still run inside each command.
The server derives `actor_user_id` from `auth.getUser()`, never caller JSON.
An infrastructure key alone does not establish an application administrator.

| Caller | Direct audit table / sequence | Audit read RPC |
| --- | --- | --- |
| Guest / authenticated client, including admin JWT | Denied | Denied |
| Trusted server, player / owner / moderator actor | Denied | Denied |
| Trusted server, current admin actor | Denied | Allowed |
| Trusted database owner | Maintenance authority | Allowed with current admin actor |

The table has RLS, no client policies and no read/write grants, including to
`service_role`. Clients cannot append, edit, delete, truncate or obtain sequence
values. `directory_admin_audit_read(actor_user_id, target_venue_id?, after_id?)`
checks/locks the current admin assignment and returns `{items,next_cursor}`,
at most 100 rows in ascending event-ID order, optionally filtered by venue.
Revoked admins lose access on the next call. Unknown venue filters return empty.
Pass the decimal-string cursor back unchanged; never use a JavaScript number.
Identity IDs may have gaps after rollback and reflect allocation order, not
transaction commit order. This is a bounded review endpoint, not a change feed.
There is no new audit browser page in T12; shared RPC contracts support later
moderation/admin tools through their own verified server guards.

Actor/venue IDs deliberately have no cascading foreign keys, so deleting a
record does not silently erase its history. These IDs remain pseudonymous
personal data; T47 must define retention and account-deletion handling. Trusted
database maintenance can change records; this is not a cryptographic seal or
auditing for direct SQL, T08 role/owner assignment, or future booking commands.

Verification: `npm run test:directory`, `npm run test:admin:local` after local
migration and `npm run admin:build`. The embedded and Docker suites cover all
actions, forged/direct access denial, role revocation, filtered pagination,
import retry/batch rollback, enclosing rollback, audit-storage failure and
history survival after account/venue deletion. Production Next/local Supabase
checks verified HTTP actor attribution and concurrent import audit deduplication.
Tests use synthetic local fixtures only and remove their own audit events through
trusted SQL; production command interfaces cannot delete history.
