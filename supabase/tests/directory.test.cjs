const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(path.dirname(module.filename), '../..');

test('directory migration, spatial lookup, data constraints and client-role isolation on disposable PostgreSQL/PostGIS', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const db = new PGlite({ extensions: { postgis } });
  try {
    // Minimal Supabase platform prerequisites, only in this in-memory test DB.
    // The real engine enforces role privileges, RLS, FK and PostGIS behavior.
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
    `);
    await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/20261006030000_directory.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(root, 'supabase/tests/directory.sql'), 'utf8'));
    const fixtures = await db.query('select count(*)::integer as count from public.venues');
    assert.equal(fixtures.rows[0].count, 0, 'all synthetic fixtures roll back');
    const evidence = await db.query('select count(*)::integer as count from private.venue_claims');
    assert.equal(evidence.rows[0].count, 0, 'claim fixtures also roll back');
  } catch (error) {
    throw new Error(`Database test ${error.code ?? ''}: ${error.message}${error.where ? ` (${error.where})` : ''}`);
  } finally {
    await db.close();
  }
});
