const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

test('owner venue editing: owner-only audited saves, version conflicts, photo limits and public reads on PostgreSQL/PostGIS', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const db = new PGlite({ extensions: { postgis, pg_trgm } });
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
    await db.exec(fs.readFileSync(path.join(root, 'tests/owner-venues.sql'), 'utf8'));
    for (const table of ['public.venues', 'public.venue_photos', 'private.venue_photo_requests', 'private.venue_owners',
      'private.directory_audit_events', 'storage.objects']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    // Every owner venue command is server-only; private helpers are callable by no API role.
    const grants = (await db.query(`select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where n.nspname in ('public', 'private') and (p.proname like 'owner_venue%' or p.proname in ('require_venue_owner', 'valid_owner_text'))
        and has_function_privilege(r.rolname, p.oid, 'execute') order by 1, 2`)).rows.map((row) => `${row.proname}:${row.rolname}`);
    assert.deepEqual(grants, ['owner_venue_list:service_role', 'owner_venue_photo_add:service_role', 'owner_venue_photo_remove:service_role',
      'owner_venue_read:service_role', 'owner_venue_save:service_role']);
    const table = (await db.query(`select r.rolname, has_table_privilege(r.rolname, 'public.venue_photos', 'select') as can_read,
      has_table_privilege(r.rolname, 'public.venue_photos', 'insert,update,delete') as can_write
      from (values ('anon'), ('authenticated'), ('service_role')) r(rolname) order by 1`)).rows;
    assert.deepEqual(table.map((row) => [row.rolname, row.can_read, row.can_write]),
      [['anon', true, false], ['authenticated', true, false], ['service_role', true, false]], 'photo rows change only through commands');
  } catch (e) { throw new Error(`Owner venue SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
