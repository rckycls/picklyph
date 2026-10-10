const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

// Each mutation weakens one T40a rule inside a transaction; venue-cancellations.sql must then fail.
const cancel = 'public.owner_booking_cancel(uuid,text,uuid,text)';
const session = 'public.owner_session_cancel(uuid,uuid,text)';
const mutations = [
  [cancel, "r.source<>'player' or ", ''],
  [cancel, "r.status<>'confirmed' or ", ''],
  [cancel, 'a.starts_at<=at_time', "a.starts_at<=at_time-interval '1 day'"],
  [cancel, "g.source<>'player' or ", ''],
  [cancel, "g.status<>'confirmed' or ", ''],
  [cancel, "s.starts_at<=at_time then", "s.starts_at<=at_time-interval '1 day' then"],
  [cancel, 'perform private.allocation_release(a.id);', ''],
  [cancel, 'update private.open_play_sessions x set reserved_spots=x.reserved_spots-g.spots where x.id=s.id;', ''],
  [cancel, 'if exists(select 1 from private.booking_cancellations c where c.booking_id=target_booking_id) then', 'if false then'],
  [cancel, "and (o.paid_at is not null or o.attendance<>'none')", 'and false'],
  [cancel, 'perform private.rental_require_owner(actor_user_id,venue);', ''],
  [session, 'and reason is null then raise', 'and false then raise'],
  [session, 'update private.open_play_sessions set reserved_spots=0 where id=saved.id;', ''],
  [session, "b.status in ('pending','confirmed') order by b.id loop", "b.status='confirmed' order by b.id loop"],
  [session, 'if saved.starts_at<=at_time then raise', 'if false then raise'],
  [session, 'cancel_reason=reason,', ''],
  [session, "and (o.paid_at is not null or o.attendance<>'none')", 'and false'],
  [session, 'perform private.allocation_release(allocation);', ''],
  ['private.notification_for_event(text,bigint,uuid,uuid,text,uuid,uuid,timestamp with time zone,text,bigint)',
    "jsonb_build_object('reason', c.reason)", 'jsonb_build_object()'],
  ['private.venue_cancellation_json(uuid)', "'reason',c.reason", "'reason',null"],
  ['private.session_immutable()', '(new.status,new.cancelled_at,new.cancel_reason,new.cancelled_by)', '(new.status,new.cancelled_at,old.cancel_reason,old.cancelled_by)'],
];

async function database() {
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
    for (const file of fs.readdirSync(path.join(__dirname, '../migrations')).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
    }
    return db;
  } catch (error) { await db.close(); throw error; }
}
const sqlError = (e) => e instanceof assert.AssertionError ? e
  : new Error(`Venue cancellations SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`);

test('venue cancellations: owner-only, confirmed future player bookings, released inventory, audited reasons, player alerts and whole sessions; every mutation is caught', async () => {
  const db = await database();
  try {
    const suite = fs.readFileSync(path.join(__dirname, 'venue-cancellations.sql'), 'utf8');
    await db.exec(suite);
    for (const table of ['auth.users', 'public.venues', 'private.booking_cancellations', 'private.notification_outbox', 'private.court_allocations']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    const grants = (await db.query(`select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where n.nspname in ('public', 'private') and (p.proname like '%\\_cancel' or p.proname like '%cancellation%')
        and has_function_privilege(r.rolname, p.oid, 'execute') order by 1, 2`)).rows.map((row) => `${row.proname}:${row.rolname}`);
    assert.deepEqual(grants, ['owner_booking_cancel:service_role', 'owner_session_cancel:service_role']);
    assert.equal((await db.query(`select count(*)::integer n from pg_proc where proname = 'owner_session_cancel'`)).rows[0].n, 1, 'one session cancel signature');
    const tables = (await db.query(`select r.rolname from (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where has_table_privilege(r.rolname, 'private.booking_cancellations', 'select,insert,update,delete')`)).rows;
    assert.deepEqual(tables, [], 'no API role reads or writes cancellation records');

    for (const [fn, from, to] of mutations) {
      const def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [fn])).rows[0].d;
      assert.ok(def.split(from).length >= 2, `${fn} contains the mutated text: ${from}`);
      await db.exec('begin;'); await db.exec(def.split(from).join(to));
      await assert.rejects(db.exec(suite), /assertion failed|Expected|cannot change/i, `${fn}: ${from} -> ${to}`);
      await db.exec('rollback;');
    }
    await db.exec('begin;'); await db.exec('drop trigger booking_cancellations_immutable on private.booking_cancellations;');
    await assert.rejects(db.exec(suite), /Expected/, 'dropped the immutability trigger');
    await db.exec('rollback;');
    await db.exec(suite);
  } catch (e) { throw sqlError(e); } finally { await db.close(); }
});
