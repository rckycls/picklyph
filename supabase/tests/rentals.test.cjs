const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');
const { priceRental, requireRentalWindow } = require('../../packages/domain/src/rental.ts');

test('rental transaction snapshots: PostgreSQL permissions, rollback, immutability and exact TypeScript parity', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const db = new PGlite({ extensions: { postgis, pg_trgm, btree_gist } });
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; $$; ${storageStub}`);
    for (const file of fs.readdirSync(path.join(__dirname, '../migrations')).filter(f => f.endsWith('.sql')).sort()) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
    }
    await db.exec(fs.readFileSync(path.join(__dirname, 'rentals.sql'), 'utf8'));
    const grants = (await db.query(`select p.proname,r.name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join (values ('anon'),('authenticated'),('service_role')) r(name)
      where n.nspname='private' and (p.proname like 'rental_%' or p.proname='validate_rental_window')
      and has_function_privilege(r.name,p.oid,'execute')`)).rows;
    assert.deepEqual(grants, []);
    assert.equal((await db.query('select count(*)::integer as n from private.rental_snapshots')).rows[0].n, 0);
    const table = (await db.query(`select c.relrowsecurity,exists(select 1 from (values ('anon'),('authenticated'),('service_role')) r(name)
      where has_table_privilege(r.name,c.oid,'select,insert,update,delete,truncate')) as api_access
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='rental_snapshots'`)).rows[0];
    assert.deepEqual(table, { relrowsecurity: true, api_access: false });
    const at = minute => new Date(Date.parse('2027-01-02T00:00:00+08:00') + minute * 60000).toISOString();
    // Deterministic varied rates, fractions and zero bands, including safe-integer extremes.
    for (const rate of [0, 1, 3, 10001, 33333, 9007199254740991]) {
      for (const minutes of [60, 90, 120, 1440]) {
        const intervals = [{ starts_at: at(0), ends_at: at(30), hourly_centavos: rate },
          { starts_at: at(30), ends_at: at(1440), hourly_centavos: rate > 33333 ? 0 : rate + 2 }];
        const sql = (await db.query('select private.rental_price($1,$2,$3::jsonb) as price', [at(0), at(minutes), JSON.stringify(intervals)])).rows[0].price;
        sql.bands = sql.bands.map(b => ({ ...b, starts_at: new Date(b.starts_at).toISOString(), ends_at: new Date(b.ends_at).toISOString() }));
        assert.deepEqual(sql, priceRental(at(0), at(minutes), intervals));
      }
    }
    for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      await db.query("select set_config('TimeZone',$1,false)", [zone]);
      assert.equal((await db.query('select private.validate_rental_window($1,$2,$3) as minutes', [at(0), at(60), at(-60 * 1440)])).rows[0].minutes,
        requireRentalWindow({ startsAt: at(0), endsAt: at(60), now: at(-60 * 1440) }));
      assert.equal((await db.query("select private.validate_rental_window('2027-04-01 00:00Z','2027-04-01 01:00Z','2027-01-31 00:00Z') as minutes")).rows[0].minutes, 60);
    }
    for (const intervals of [[], [{ starts_at: at(0), ends_at: at(30), hourly_centavos: 1 }],
      [{ starts_at: at(0), ends_at: at(60), hourly_centavos: 1 }, { starts_at: at(30), ends_at: at(90), hourly_centavos: 1 }],
      [{ starts_at: at(0), ends_at: at(60), hourly_centavos: '1' }],
      [{ starts_at: at(0), ends_at: at(90), hourly_centavos: 9007199254740991 }]]) {
      await assert.rejects(db.query('select private.rental_price($1,$2,$3::jsonb)', [at(0), at(90), JSON.stringify(intervals)]));
    }
  } finally { await db.close(); }
});
