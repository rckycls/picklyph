const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

const READ = 'public.prelaunch_admin_read(uuid,text,text,timestamp with time zone,uuid)';
const ROTATE = 'public.prelaunch_admin_rotate(uuid,uuid,integer,text)';
const ERASE = 'public.prelaunch_admin_erase(uuid,uuid)';
const SENT = 'public.prelaunch_email_sent(uuid,integer)';
// Each mutation weakens one rule; the suite must notice every one. Pairs apply together.
const mutations = [
  [READ, [['perform private.require_directory_admin(actor_user_id);', '']]],
  [READ, [["'contact', case when p.status = 'erased' then null else", "'contact', case when false then null else"]]],
  [READ, [['where (status_filter is null or r.status = status_filter) and (wanted is null or r.email = wanted)',
    'where (status_filter is null or r.status = status_filter) and true']]],
  [READ, [['where (status_filter is null or r.status = status_filter) and', 'where true and']]],
  [READ, [['from private.venue_registrations r where wanted is null or r.email = wanted));', 'from private.venue_registrations r));']]],
  [READ, [['(r.created_at, r.id) < (after_created_at, after_id)', '(r.created_at, r.id) <= (after_created_at, after_id)']]],
  [READ, [["wanted := nullif(lower(btrim(email_filter)), '');", 'wanted := email_filter;']]],
  [READ, [["status_filter not in ('open', 'claimed', 'erased')", "status_filter not in ('open', 'claimed', 'erased', 'pending')"]]],
  [ROTATE, [['perform private.require_directory_admin(actor_user_id);', '']]],
  [ROTATE, [["if item.status <> 'open' then", 'if false then']]],
  [ROTATE, [['if item.code_version <> expected_version then', 'if false then']]],
  [ROTATE, [["if listing.publication_status = 'suspended' then", 'if false then']]],
  [ROTATE, [["if listing.claim_status = 'verified' then", 'if false then']]],
  [ROTATE, [['if exists (select 1 from private.venue_registrations r where r.code_hash = prelaunch_admin_rotate.code_hash) then', 'if false then']]],
  [ROTATE, [["insert into private.directory_audit_events (actor_user_id, target_venue_id, action)\n    values (actor_user_id, item.venue_id, 'prelaunch.code_send');", 'perform 1;']]],
  [ROTATE, [['code_version = r.code_version + 1', 'code_version = r.code_version']]],
  [ERASE, [['perform private.require_directory_admin(actor_user_id);', '']]],
  [ERASE, [["if item.status = 'erased' then", 'if false then']]],
  [ERASE, [["if item.status = 'open' then", 'if true then']]],
  [ERASE, [["where v.id = item.venue_id and v.publication_status = 'draft';", 'where v.id = item.venue_id;']]],
  [ERASE, [["update public.venues v set publication_status = 'suspended' where v.id = item.venue_id and v.publication_status = 'draft';", 'perform 1;']]],
  [ERASE, [["insert into private.directory_audit_events (actor_user_id, target_venue_id, action)\n    values (actor_user_id, item.venue_id, 'prelaunch.erase');", 'perform 1;']]],
  [ERASE, [['note = null, code_hash = null, erased_at = clock_timestamp() where r.id = item.id;', 'note = null, erased_at = clock_timestamp() where r.id = item.id and false;']]],
  [SENT, [['email_sent_version = sent_version', 'email_sent_version = coalesce(r.email_sent_version, sent_version)']]],
];

test('pre-launch registrations in the console (T54b): the admin-only list, code rotation and erasure on PostgreSQL/PostGIS; every mutation is caught', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const db = new PGlite({ extensions: { postgis, pg_trgm, btree_gist } });
  try {
    // Redemption compares the account email, so this stub (unlike the shared one) carries it.
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon, authenticated, service_role;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
        select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid; $$;
      ${storageStub}`);
    const root = path.resolve(__dirname, '..');
    for (const file of fs.readdirSync(path.join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(fs.readFileSync(path.join(root, 'migrations', file), 'utf8'));
    }
    const suite = fs.readFileSync(path.join(__dirname, 'prelaunch-admin.sql'), 'utf8');
    await db.exec(suite);
    for (const table of ['private.venue_registrations', 'private.venue_submissions', 'private.directory_audit_events', 'public.venues']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    assert.equal((await db.query("select to_regnamespace('pa_test') is null as gone")).rows[0].gone, true);

    for (const [fn, pairs] of mutations) {
      let def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [fn])).rows[0].d;
      for (const [from, to] of pairs) {
        assert.equal(def.split(from).length, 2, `${fn} contains the mutated text once: ${from}`);
        def = def.replace(from, to);
      }
      await db.exec('begin;'); await db.exec(def);
      await assert.rejects(db.exec(suite), /assertion failed/i, `${fn}: ${pairs.map(([, to]) => to).join(' / ')}`);
      await db.exec('rollback;');
    }
  } catch (e) { throw new Error(`Prelaunch admin SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
