const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');

const RECORD = 'public.crash_report_record(jsonb)';
const READ = 'public.crash_admin_read(uuid)';
const HEALTH = 'private.ops_health(timestamptz)';
const SWEEP = 'private.privacy_retention_sweep(integer)';
// Each mutation weakens one rule; the suite must notice every one.
const mutations = [
  [RECORD, [['or (select array_agg(k order by k) from jsonb_object_keys(report) k) is distinct from (select array_agg(k order by k) from unnest(keys) k)', 'or false']]],
  [RECORD, [["k in ('stack','component_stack','route')", "k in ('stack','component_stack','route','message')"]]],
  [RECORD, [["or report->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'", 'or false']]],
  [RECORD, [["or report->>'occurred_at' !~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?(Z|[+-]\\d{2}:\\d{2})$' then", 'then']]],
  [RECORD, [["return jsonb_build_object('outcome', 'existing');", "return jsonb_build_object('outcome', 'stored');"]]],
  [RECORD, [['>= 2000 then', '>= 2001 then']]],
  [RECORD, [["clock_timestamp() - interval '24 hours') >= 2000", "clock_timestamp() - interval '48 hours') >= 2000"]]],
  [RECORD, [['exception when check_violation or datetime_field_overflow or invalid_datetime_format then', 'exception when division_by_zero then']]],
  [HEALTH, [["c.kind in ('fatal','render')", "c.kind in ('fatal')"]]],
  [HEALTH, [["and c.variant <> 'development'", '']]],
  [HEALTH, [["c.received_at > at_time - interval '1 hour'", "c.received_at > at_time - interval '2 hours'"]]],
  [HEALTH, [["private.ops_check('app.crashes', n, 1, 10)", "private.ops_check('app.crashes', n, 2, 10)"]]],
  [HEALTH, [["private.ops_check('app.crashes', n, 1, 10)", "private.ops_check('app.crashes', n, 1, 11)"]]],
  [READ, [['perform private.require_directory_admin(actor_user_id);', '']]],
  [READ, [["'total', (select count(*) from private.app_crashes c where c.received_at > at_time - interval '7 days')",
    "'total', (select count(*) from private.app_crashes c where c.received_at > at_time - interval '8 days')"]]],
  [READ, [["from private.app_crashes c where c.received_at > at_time - interval '7 days'\n        group by",
    "from private.app_crashes c where c.received_at > at_time - interval '8 days'\n        group by"]]],
  [READ, [['group by c.fingerprint order by max(c.received_at) desc, c.fingerprint limit 50', 'group by c.fingerprint order by c.fingerprint limit 50']]],
  [READ, [['limit 50) g', 'limit 51) g']]],
  [READ, [['order by g.last_seen desc, g.fingerprint)', 'order by g.fingerprint)']]],
  [READ, [["count(*) filter (where c.variant = 'preview') preview", "count(*) filter (where c.variant = 'production') preview"]]],
  [READ, [['min(c.received_at) first_seen', 'max(c.received_at) first_seen']]],
  [READ, [['order by c.received_at desc, c.id limit 1) l', 'order by c.received_at, c.id limit 1) l']]],
  [SWEEP, [["x.received_at < clock_timestamp() - interval '30 days'", "x.received_at < clock_timestamp() - interval '28 days'"]]],
  [SWEEP, [['order by x.received_at, x.id limit batch_limit', 'order by x.received_at desc, x.id limit batch_limit']]],
  [SWEEP, [['or claimed = batch_limit or crashes = batch_limit);', 'or claimed = batch_limit);']]],
];

test('crash reports (T51d): strict service-only record, one row per report, daily cap, app.crashes, admin-only 7-day groups, 30-day retention; every mutation is caught', async () => {
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
    const suite = fs.readFileSync(path.join(__dirname, 'crash-reports.sql'), 'utf8');
    await db.exec(suite);
    for (const table of ['private.app_crashes', 'private.ops_signals', 'private.account_roles']) {
      assert.equal((await db.query(`select count(*)::integer as n from ${table}`)).rows[0].n, 0, `${table} fixtures roll back`);
    }
    assert.equal((await db.query("select to_regnamespace('cr_test') is null as gone")).rows[0].gone, true);

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
  } catch (e) { throw new Error(`Crash reports SQL ${e.code ?? ''}: ${e.message}${e.where ? ` (${e.where})` : ''}`); }
  finally { await db.close(); }
});
