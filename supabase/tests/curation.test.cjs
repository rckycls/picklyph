const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
test('admin curation, transaction rollback, import retries and directory isolation on real PostgreSQL/PostGIS', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const db = new PGlite({ extensions: { postgis, pg_trgm } });
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon, authenticated, service_role;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
        select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid; $$;`);
    const root = path.resolve(path.dirname(module.filename), '..');
    for (const file of fs.readdirSync(path.join(root, 'migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
    await db.exec(fs.readFileSync(path.join(root, 'tests/curation.sql'), 'utf8'));
    for (const table of ['public.venues', 'public.courts', 'public.profiles', 'private.directory_import_refs']) assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0);
  } catch (e) { throw new Error(`Curation SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
