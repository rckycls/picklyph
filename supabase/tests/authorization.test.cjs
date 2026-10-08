const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

const root = path.resolve(path.dirname(module.filename), '../..');

test('profile lifecycle, role grants/revocation, venue scope and client isolation on disposable PostgreSQL/PostGIS', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const db = new PGlite({ extensions: { postgis, pg_trgm, btree_gist } });
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      grant usage on schema auth to anon, authenticated, service_role;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
        select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
      $$;
      insert into auth.users(id) values ('10000000-0000-4000-8000-000000000099');
      ${storageStub}
    `);
    for (const migration of ['20261006030000_directory.sql', '20261006090000_authorization.sql']) {
      await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations', migration), 'utf8'));
    }
    const backfilled = await db.query('select count(*)::integer as count from public.profiles');
    assert.equal(backfilled.rows[0].count, 1, 'migration backfills the pre-existing Auth user');
    // Then every later migration, as the Docker run sees it (T46 replaced the direct owner RPC).
    for (const migration of fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql') && f > '20261006090000_authorization.sql').sort()) {
      await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations', migration), 'utf8'));
    }
    await db.exec(fs.readFileSync(path.join(root, 'supabase/tests/directory.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(root, 'supabase/tests/authorization.sql'), 'utf8'));
    for (const table of ['private.account_roles', 'private.venue_owners', 'private.venue_claims', 'public.venues']) {
      const result = await db.query(`select count(*)::integer as count from ${table}`);
      assert.equal(result.rows[0].count, 0, `${table} fixtures roll back`);
    }
    const profiles = await db.query('select count(*)::integer as count from public.profiles');
    assert.equal(profiles.rows[0].count, 1, 'only the backfilled pre-migration profile remains');
  } catch (error) {
    throw new Error(`Authorization database test ${error.code ?? ''}: ${error.message}${error.where ? ` (${error.where})` : ''}`);
  } finally {
    await db.close();
  }
});
