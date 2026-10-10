const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

// Each mutation weakens one T43 rule inside a transaction; the suite must then fail.
const mutations = [
  ['private.notification_for_event(text,bigint,uuid,uuid,text,uuid,uuid,timestamp with time zone,text,bigint)',
    'recipients := array(select r from unnest(recipients) r where r is distinct from actor);', 'recipients := recipients;'],
  ['private.notification_for_event(text,bigint,uuid,uuid,text,uuid,uuid,timestamp with time zone,text,bigint)', 'if actor = player then', 'if false then'],
  ['private.notification_for_event(text,bigint,uuid,uuid,text,uuid,uuid,timestamp with time zone,text,bigint)',
    "case when booking_status = 'pending' then 'booking.requested' else 'booking.created' end", "'booking.requested'"],
  ['private.notification_for_event(text,bigint,uuid,uuid,text,uuid,uuid,timestamp with time zone,text,bigint)',
    "when 'expire' then event_kind := 'booking.expired'; audience := 'player'; recipients := array[player];", ''],
  ['private.rental_event_notify()', "if b.source <> 'player' then return null; end if;", ''],
  ['private.session_event_notify()', "if b.source <> 'player' then return null; end if;", ''],
  ['private.notification_enqueue(text,bigint,text,uuid[],jsonb)',
    'and exists (select 1 from private.push_devices d where d.user_id = r.id and d.disabled_at is null)', ''],
  ['private.notification_enqueue(text,bigint,text,uuid[],jsonb)', 'and not exists (select 1 from private.account_deletions d where d.user_id = r.id)', ''],
  ['public.push_device_register(uuid,jsonb)', 'if exists (select 1 from private.account_deletions d where d.user_id = actor_user_id) then', 'if false then'],
  ['public.push_device_register(uuid,jsonb)', 'order by x.seen_at desc, x.id desc offset 10', 'order by x.seen_at desc, x.id desc offset 11'],
  ['public.push_device_register(uuid,jsonb)', 'update private.push_devices set platform = device_platform, seen_at = at_time, disabled_at = null',
    'update private.push_devices set platform = device_platform, seen_at = at_time'],
  ['public.push_device_unregister(uuid,jsonb)', 'and d.user_id = actor_user_id', ''],
  ['public.push_outbox_claim(integer,integer)', "interval '6 hours'", "interval '8 hours'"],
  ['public.push_outbox_claim(integer,integer)',
    'and not exists (select 1 from private.push_deliveries p where p.outbox_id = item.id and p.device_id = d.id);', ';'],
  ['public.push_outbox_claim(integer,integer)', "where x.finished_at < at_time - interval '30 days'", "where x.finished_at < at_time - interval '40 days'"],
  ['public.push_outbox_complete(jsonb)', "or item.claim_id <> (entry->>'claim_id')::uuid", ''],
  ['public.push_outbox_complete(jsonb)', 'item.attempts >= 5', 'item.attempts >= 6'],
  ['public.push_outbox_complete(jsonb)', 'update private.push_devices set disabled_at = at_time where id = device.id and disabled_at is null;', 'null;'],
  ['public.push_outbox_complete(jsonb)', 'and d.user_id = item.recipient_user_id;', ';'],
  ['public.push_outbox_complete(jsonb)', 'least(30 * power(2, item.attempts - 1), 900)', 'least(30 * power(2, item.attempts), 900)'],
  ['public.push_receipts_due(integer)', "p.sent_at <= at_time - interval '15 minutes'", 'p.sent_at <= at_time'],
  ['public.push_receipts_due(integer)', "x.sent_at < at_time - interval '24 hours'", "x.sent_at < at_time - interval '26 hours'"],
  ['public.push_receipts_record(jsonb)', "where p.ticket_id = entry->>'ticket_id' and p.receipt is null", "where p.ticket_id = entry->>'ticket_id'"],
  ['public.push_receipts_record(jsonb)', "update private.push_devices set disabled_at = clock_timestamp() where id = device and disabled_at is null;", 'null;'],
];
const droppedTriggers = [['rental_events_notify', 'private.rental_events'], ['session_booking_events_notify', 'private.session_booking_events']];

test('push notifications: registration, booking-event outbox, leases, retries, invalid tokens, receipts and cascades; every mutation is caught', async () => {
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
    const suite = fs.readFileSync(path.join(__dirname, 'notifications.sql'), 'utf8');
    await db.exec(suite);
    for (const table of ['auth.users', 'public.venues', 'private.push_devices', 'private.notification_outbox', 'private.push_deliveries', 'private.court_allocations']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    // The worker and registration commands are server-only; helpers, triggers and tables are reachable by no API role.
    const grants = (await db.query(`select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where n.nspname in ('public', 'private') and (p.proname like 'push\\_%' or p.proname like 'notification\\_%' or p.proname like '%\\_event\\_notify')
        and has_function_privilege(r.rolname, p.oid, 'execute') order by 1, 2`)).rows.map((row) => `${row.proname}:${row.rolname}`);
    assert.deepEqual(grants, ['push_device_register:service_role', 'push_device_unregister:service_role', 'push_outbox_claim:service_role',
      'push_outbox_complete:service_role', 'push_receipts_due:service_role', 'push_receipts_record:service_role']);
    const tables = (await db.query(`select t, r.rolname from (values ('private.push_devices'), ('private.notification_outbox'), ('private.push_deliveries')) x(t)
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
      where has_table_privilege(r.rolname, x.t, 'select,insert,update,delete')`)).rows;
    assert.deepEqual(tables, [], 'no API role can read or change devices, the outbox or deliveries');

    for (const [fn, from, to] of mutations) {
      const def = (await db.query('select pg_get_functiondef($1::regprocedure) d', [fn])).rows[0].d;
      assert.equal(def.split(from).length, 2, `${fn} contains the mutated text once: ${from}`);
      await db.exec('begin;'); await db.exec(def.replace(from, to));
      await assert.rejects(db.exec(suite), /assertion failed|Expected|duplicate key|violates/i, `${fn}: ${to}`);
      await db.exec('rollback;');
    }
    for (const [name, table] of droppedTriggers) {
      await db.exec('begin;'); await db.exec(`drop trigger ${name} on ${table};`);
      await assert.rejects(db.exec(suite), /assertion failed/, `dropped ${name}`);
      await db.exec('rollback;');
    }
    assert.equal((await db.query(`select count(*)::integer n from pg_trigger where tgname like '%\\_notify'`)).rows[0].n, 2, 'triggers restored');
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    throw new Error(`Notifications SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`);
  } finally { await db.close(); }
});
