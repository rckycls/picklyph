const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

test('personal details and private profile photos: self-only edits, constraints and storage isolation on PostgreSQL', async () => {
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
    await db.exec(fs.readFileSync(path.join(root, 'tests/profile.sql'), 'utf8'));
    assert.equal((await db.query('select count(*)::integer as n from public.profiles')).rows[0].n, 0, 'fixtures roll back');
    const updatable = (await db.query(`select column_name from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'profiles' and grantee = 'authenticated' and privilege_type = 'UPDATE'
      order by 1`)).rows.map((row) => row.column_name);
    assert.deepEqual(updatable, ['avatar_path', 'display_name', 'first_name', 'last_name', 'phone'], 'only personal fields are client-editable');
  } catch (e) { throw new Error(`Profile SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
