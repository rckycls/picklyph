const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

test('ownership review: reviewer-only queue/evidence, audited decisions, duplicate resolution and retries on PostgreSQL/PostGIS', async () => {
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
    await db.exec(fs.readFileSync(path.join(root, 'tests/review.sql'), 'utf8'));
    for (const table of ['public.venues', 'public.profiles', 'private.venue_claims', 'private.venue_submissions',
      'private.venue_owners', 'private.ownership_audit_events', 'private.directory_audit_events']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    // Every review command is server-only; private helpers are callable by no API role.
    const grants = (await db.query(`select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where n.nspname in ('public', 'private') and (p.proname like 'ownership_review%' or p.proname in ('require_ownership_reviewer', 'ownership_submitter'))
        and has_function_privilege(r.rolname, p.oid, 'execute') order by 1, 2`)).rows.map((row) => `${row.proname}:${row.rolname}`);
    assert.deepEqual(grants, ['ownership_review_decide:service_role', 'ownership_review_evidence:service_role',
      'ownership_review_queue:service_role', 'ownership_review_read:service_role']);
  } catch (e) { throw new Error(`Review SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
