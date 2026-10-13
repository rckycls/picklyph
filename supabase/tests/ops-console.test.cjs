const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

const READ = 'public.ops_admin_read(uuid)';
const RUN = 'public.ops_monitor_run(jsonb)';
// Each mutation weakens one rule; the suite must notice every one.
const mutations = [
  [READ, [['perform private.require_directory_admin(actor_user_id);', '']]],
  [READ, [["'checks', private.ops_health(at_time),", "'checks', '[]'::jsonb,"]]],
  [READ, [["'present', m.jobid is not null", "'present', true"]]],
  [READ, [['order by j.active desc, j.jobid desc limit 1', 'order by j.jobid desc limit 1']]],
  [READ, [["where d.start_time > at_time - interval '24 hours' and", "where d.start_time > at_time - interval '48 hours' and"]]],
  [READ, [['order by r.start_time desc, r.runid desc limit 1) last_run', 'order by r.start_time, r.runid limit 1) last_run']]],
  [READ, [["r.jobid = m.jobid and r.status = 'succeeded'", "r.jobid = m.jobid and r.status <> 'failed'"]]],
  [READ, [["(select count(*) from recent r where r.jobid = m.jobid and r.status = 'failed')", '(select count(*) from recent r where r.jobid = m.jobid)']]],
  [READ, [["where r.jobid = m.jobid and r.status = 'failed'\n        order by", 'where r.jobid = m.jobid\n        order by']]],
  [READ, [['left(last_failure.return_message, 300)', 'last_failure.return_message']]],
  [READ, [["'monitor_ran_at', (select max(x.checked_at)", "'monitor_ran_at', (select min(x.checked_at)"]]],
  [READ, [["'last_15m', least(g.m15, 1000000)", "'last_15m', g.m15"]]],
  [READ, [["filter (where s.minute > at_time - interval '15 minutes')", "filter (where s.minute > at_time - interval '30 minutes')"]]],
  [READ, [["filter (where s.minute > at_time - interval '1 hour')", "filter (where s.minute > at_time - interval '2 hours')"]]],
  [READ, [["from private.ops_signals s where s.minute > at_time - interval '24 hours'", 'from private.ops_signals s where true']]],
  [READ, [['order by g.source, g.kind', 'order by g.kind, g.source']]],
  [READ, [["'checked_at', x.checked_at, 'notified_status', x.notified_status", "'checked_at', x.since, 'notified_status', x.notified_status"]]],
  [RUN, [['status = excluded.status, checked_at = excluded.checked_at,', 'status = excluded.status,']]],
];

test('console health read (T51c): admin-only, live checks, monitor state and run time, jobs and signals, no writes; every mutation is caught', async () => {
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
    const suite = fs.readFileSync(path.join(__dirname, 'ops-console.sql'), 'utf8');
    await db.exec(suite);
    for (const table of ['private.ops_alert_state', 'private.ops_signals', 'private.account_roles']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    assert.equal((await db.query("select to_regnamespace('oc_test') is null and to_regclass('cron.job') is null as gone")).rows[0].gone, true);

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
  } catch (e) { throw new Error(`Ops console SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
