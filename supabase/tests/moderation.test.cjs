const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

test('moderation: reports, reviewer-only decisions, suspension vs every booking command, reinstatement and audited revocation on PostgreSQL/PostGIS', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const db = new PGlite({ extensions: { postgis, pg_trgm, btree_gist: (await import('@electric-sql/pglite/contrib/btree_gist')).btree_gist } });
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon, authenticated, service_role;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
        select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid; $$;
      ${storageStub}`);
    const root = path.resolve(__dirname, '..');
    for (const file of fs.readdirSync(path.join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
    }
    await db.exec(fs.readFileSync(path.join(root, 'tests/moderation.sql'), 'utf8'));
    for (const table of ['public.venues', 'private.venue_owners', 'private.venue_reports', 'private.venue_moderation_suspensions',
      'private.moderation_audit_events', 'private.directory_audit_events', 'private.court_allocations', 'private.session_bookings']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    // Moderation commands are server-only; private helpers and tables are reachable by no API role.
    const grants = (await db.query(`select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where n.nspname in ('public', 'private') and p.proname in ('venue_report_submit', 'moderation_queue', 'moderation_venue_read',
        'moderation_decide', 'ownership_revoke', 'require_moderator', 'has_venue_stake', 'venue_report_item', 'moderation_item',
        'clear_moderation_suspension', 'set_verified_venue_owner')
        and has_function_privilege(r.rolname, p.oid, 'execute') order by 1, 2`)).rows.map((row) => `${row.proname}:${row.rolname}`);
    assert.deepEqual(grants, ['moderation_decide:service_role', 'moderation_queue:service_role', 'moderation_venue_read:service_role',
      'ownership_revoke:service_role', 'venue_report_submit:service_role']);
    const tables = (await db.query(`select c.relname, r.rolname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where n.nspname = 'private' and c.relname in ('venue_reports', 'venue_moderation_suspensions', 'moderation_audit_events', 'moderation_audit_events_id_seq')
        and (has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete')
          or (c.relkind = 'S' and has_sequence_privilege(r.rolname, c.oid, 'usage,select,update')))`)).rows;
    assert.deepEqual(tables, [], 'no API role can touch reports, markers or moderation history directly');
  } catch (e) { throw new Error(`Moderation SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
