const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

// Each mutation weakens one T47 rule inside a transaction; the suite must then fail.
const mutations = [
  ['public.account_deletion_begin(uuid)', 'if exists (select 1 from private.account_roles r where r.user_id = actor_user_id) then', 'if false then'],
  ['public.account_deletion_begin(uuid)', "update public.venues v set claim_status = 'unclaimed' where v.id = item.venue_id;", 'null;'],
  ['public.account_deletion_begin(uuid)', "'owner.revoke', actor_user_id, 'owner_request'", "'owner.revoke', actor_user_id, 'other'"],
  ['public.account_deletion_begin(uuid)', "publication_status = case when v.publication_status = 'draft' then 'suspended' else v.publication_status end,", 'publication_status = v.publication_status,'],
  ['public.account_deletion_begin(uuid)', "a.kind = 'rental' and b.source = 'player'", "a.kind = 'rental'"],
  ['public.account_deletion_begin(uuid)', "result := public.session_booking_change(actor_user_id, item.id, 'cancel');", 'result := null;'],
  ['public.account_deletion_begin(uuid)', "where b.requested_by = actor_user_id and b.source = 'player' and b.participants", 'where b.requested_by = actor_user_id and b.participants'],
  ['public.account_deletion_status(uuid)', "then 'pending'", "then 'deleted'"],
  ['private.session_booking_guard()', 'and exists (select 1 from private.account_deletions d where d.user_id = old.requested_by) then', 'then'],
  ['private.session_booking_guard()', 'new.expires_at,new.updated_at)', 'new.expires_at,old.updated_at)'],
  ['private.refuse_deleting_account()', 'if exists (select 1 from private.account_deletions d where d.user_id = who) then', 'if false then'],
  ['private.privacy_retention_sweep(integer)', "interval '180 days'", "interval '170 days'"],
];
const droppedTriggers = [['court_allocations_account_deleting', 'private.court_allocations'], ['session_bookings_account_deleting', 'private.session_bookings'],
  ['venue_owners_account_deleting', 'private.venue_owners'], ['account_roles_account_deleting', 'private.account_roles'],
  ['venue_claims_account_deleting', 'private.venue_claims'], ['venue_submissions_account_deleting', 'private.venue_submissions'],
  ['venue_reports_account_deleting', 'private.venue_reports']];

test('account deletion: console refusal, booking cancellation, name erasure, venue release, in-progress guards, cascades and report retention; every mutation is caught', async () => {
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
    const suite = fs.readFileSync(path.join(__dirname, 'account-deletion.sql'), 'utf8');
    await db.exec(suite);
    for (const table of ['auth.users', 'public.venues', 'private.account_deletions', 'private.venue_owners', 'private.venue_reports',
      'private.court_allocations', 'private.session_bookings', 'private.moderation_audit_events', 'private.directory_audit_events']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    // Deletion commands are server-only; private helpers and the deletion record are reachable by no API role.
    const grants = (await db.query(`select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where n.nspname in ('public', 'private') and p.proname in ('account_deletion_begin', 'account_deletion_status', 'refuse_deleting_account',
        'erased_names', 'privacy_retention_sweep', 'privacy_retention_schedule')
        and has_function_privilege(r.rolname, p.oid, 'execute') order by 1, 2`)).rows.map((row) => `${row.proname}:${row.rolname}`);
    assert.deepEqual(grants, ['account_deletion_begin:service_role', 'account_deletion_status:service_role']);
    const tables = (await db.query(`select r.rolname from (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where has_table_privilege(r.rolname, 'private.account_deletions', 'select,insert,update,delete')`)).rows;
    assert.deepEqual(tables, [], 'no API role can read or change deletion records');

    for (const [fn, from, to] of mutations) {
      const def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [fn])).rows[0].d;
      assert.equal(def.split(from).length, 2, `${fn} contains the mutated text once: ${from}`);
      await db.exec('begin;'); await db.exec(def.replace(from, to));
      await assert.rejects(db.exec(suite), /assertion failed|Expected|immutable|Owner|owner|authorization/i, `${fn}: ${to}`);
      await db.exec('rollback;');
    }
    for (const [name, table] of droppedTriggers) {
      await db.exec('begin;'); await db.exec(`drop trigger ${name} on ${table};`);
      await assert.rejects(db.exec(suite), /Expected failure/, `dropped ${name}`);
      await db.exec('rollback;');
    }
    assert.equal((await db.query(`select count(*)::integer n from pg_trigger where tgname like '%_account_deleting'`)).rows[0].n, 10, 'triggers restored (T43 adds push devices)');
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    throw new Error(`Account deletion SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`);
  } finally { await db.close(); }
});
