const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

// Each mutation weakens one rule; the suite must notice every one. Pairs apply together.
const mutations = [
  ['public.prelaunch_register(uuid,jsonb,text,boolean)', [["'draft', 'unclaimed')", "'draft', 'pending')"]]],
  ['public.prelaunch_register(uuid,jsonb,text,boolean)', [['>= 10 then', '>= 11 then']]],
  ['public.prelaunch_register(uuid,jsonb,text,boolean)', [['if jsonb_array_length(public_duplicates) > 0 and not acknowledge_duplicates then', 'if false then']]],
  ['public.prelaunch_register(uuid,jsonb,text,boolean)', [["if existing.status = 'open' and existing.email_sent_at is null then", "if existing.status = 'open' then"]]],
  ['public.prelaunch_register(uuid,jsonb,text,boolean)', [['if existing.email is distinct from contact_email then', 'if false then']]],
  ['public.prelaunch_register(uuid,jsonb,text,boolean)', [["values (saved_id, draft_id, 'prelaunch.register');", "select saved_id, draft_id, 'prelaunch.register' where false;"]]],
  ['public.prelaunch_register(uuid,jsonb,text,boolean)', [["(registration -> 'courts' ->> 'indoor')::boolean", 'false']]],
  ['public.prelaunch_register(uuid,jsonb,text,boolean)', [['acknowledge_duplicates, nearby_ids, prelaunch_register.code_hash)', "acknowledge_duplicates, '{}', prelaunch_register.code_hash)"]]],
  ['public.prelaunch_email_sent(uuid,integer)', [['r.code_version = sent_version and ', '']]],
  ['private.validate_prelaunch_registration(jsonb)', [["or registration -> 'consent' is distinct from 'true'::jsonb then", 'then']]],
  ['private.validate_prelaunch_registration(jsonb)', [["or registration ->> 'role' not in ('owner', 'manager', 'staff')", '']]],
  ['private.validate_prelaunch_registration(jsonb)', [["or registration ->> 'email' <> lower(btrim(registration ->> 'email'))", '']]],
  ['private.privacy_retention_sweep(integer)', [["and v.publication_status = 'draft';", ';']]],
  ['private.privacy_retention_sweep(integer)', [["'prelaunch_registrations', erased", "'prelaunch_registrations', 0"]]],
  ['private.privacy_retention_sweep(integer)', [["- interval '180 days'\n    order by coalesce", "- interval '1 days'\n    order by coalesce"],
    ["- interval '180 days' for update", "- interval '1 days' for update"]]],
  ['private.privacy_retention_sweep(integer)', [['erased := erased + 1;', 'erased := erased + 1; exit;']]],
  ['private.directory_delete_blocker(uuid)', [["when exists (select 1 from private.venue_registrations r where r.venue_id = target_venue_id) then 'registration'", '']]],
];

test('pre-launch registrations (T53): private unclaimed drafts, retries and rotation, cap, invisibility and the privacy sweep on PostgreSQL/PostGIS; every mutation is caught', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const db = new PGlite({ extensions: { postgis, pg_trgm, btree_gist } });
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
    const suite = fs.readFileSync(path.join(__dirname, 'prelaunch.sql'), 'utf8');
    await db.exec(suite);
    for (const table of ['private.venue_registrations', 'public.venues', 'public.courts', 'private.directory_audit_events']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    assert.equal((await db.query("select to_regnamespace('pre_test') is null as gone")).rows[0].gone, true);

    for (const [fn, pairs] of mutations) {
      let def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [fn])).rows[0].d;
      for (const [from, to] of pairs) {
        assert.equal(def.split(from).length, 2, `${fn} contains the mutated text once: ${from}`);
        def = def.replace(from, to);
      }
      await db.exec('begin;'); await db.exec(def);
      await assert.rejects(db.exec(suite), /assertion failed|Expected/i, `${fn}: ${pairs.map(([, to]) => to).join(' / ')}`);
      await db.exec('rollback;');
    }
  } catch (e) { throw new Error(`Prelaunch SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
