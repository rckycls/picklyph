const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { storageStub } = require('./platform.cjs');
const { resolveVenueSchedule, readVenueSchedule } = require('../../packages/domain/src/schedule.ts');

test('schedule permissions, versions, rollback and SQL/TypeScript resolver parity on PostgreSQL/PostGIS', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const db = new PGlite({extensions:{postgis,pg_trgm}});
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon, authenticated, service_role;
      create table auth.users(id uuid primary key, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'sub')::uuid; $$; ${storageStub}`);
    for (const file of fs.readdirSync(path.join(__dirname,'../migrations')).filter(f=>f.endsWith('.sql')).sort())
      await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname,'schedules.sql'),'utf8'));
    assert.equal((await db.query('select count(*)::integer as n from private.venue_schedules')).rows[0].n,0);
    const grants=(await db.query(`select p.proname,r.name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join (values ('anon'),('authenticated'),('service_role')) r(name)
      where n.nspname in ('public','private') and (p.proname like 'schedule_%' or p.proname like '%venue_schedule%' or p.proname='require_schedule_editor')
      and has_function_privilege(r.name,p.oid,'execute') order by 1,2`)).rows;
    assert.deepEqual(grants,[{proname:'venue_schedule_read',name:'service_role'},{proname:'venue_schedule_save',name:'service_role'}]);
    const privateAccess=(await db.query(`select c.relname,c.relrowsecurity,
      exists(select 1 from (values ('anon'),('authenticated'),('service_role')) r(name)
      where has_table_privilege(r.name,c.oid,'select,insert,update,delete')) as api_access
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
      and c.relname in ('venue_schedules','schedule_exceptions','schedule_windows','schedule_rates')`)).rows;
    assert.equal(privateAccess.length,4);
    assert.ok(privateAccess.every(row=>row.relrowsecurity&&!row.api_access),'all schedule tables have RLS and no API grants');
    await db.exec(`begin; insert into auth.users(id) values ('61000000-0000-4000-8000-000000000003');
      insert into private.account_roles(user_id,role) values ('61000000-0000-4000-8000-000000000003','admin');
      insert into public.venues(id,name,address_line,city,province,latitude,longitude) values
      ('62000000-0000-4000-8000-000000000001','Parity','Fixture','Manila','Metro Manila',14.6,121);`);
    let revision=null;
    const window=(a,b,c=25000)=>({start_minute:a,end_minute:b,rates:[{start_minute:a,end_minute:b,hourly_centavos:c}]});
    const blank=()=>({weekly:Array.from({length:7},()=>[]),exceptions:[]});
    const samples=[];
    const overnight=blank(); overnight.weekly[6]=[window(1320,1560)]; samples.push(overnight);
    const special=structuredClone(overnight); special.exceptions=[{date:'2026-10-04',windows:[window(60,180,30000)]}]; samples.push(special);
    const closure=structuredClone(overnight); closure.exceptions=[{date:'2026-10-04',windows:[]}]; samples.push(closure);
    const bounds=blank(); bounds.exceptions=[{date:'2026-12-31',windows:[window(1410,1470,Number.MAX_SAFE_INTEGER)]},{date:'2024-02-28',windows:[window(1410,1470,0)]}]; samples.push(bounds);
    // Deterministic varied hours/rate splits exercise every weekly boundary.
    for(let n=0;n<14;n++) {const s=blank(); const day=n%7; const start=n%2?1320:480; const end=start+180;
      s.weekly[day]=[window(start,end)];s.weekly[day][0].rates=[{start_minute:start,end_minute:start+60,hourly_centavos:n},
      {start_minute:start+60,end_minute:end,hourly_centavos:50000}];samples.push(s);}
    for(const schedule of samples) {
      const view=(await db.query(`select public.venue_schedule_save('61000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000001',$1,$2::jsonb) as view`,[revision,JSON.stringify(schedule)])).rows[0].view;
      revision=view.revision; assert.deepEqual(view.schedule,readVenueSchedule(schedule));
      for(const date of ['2026-10-03','2026-12-31','2024-02-28']) {
        const sql=(await db.query(`select private.resolve_venue_schedule('62000000-0000-4000-8000-000000000001',$1::date,8) as intervals`,[date])).rows[0].intervals;
        assert.deepEqual(sql.map(i=>({...i,starts_at:new Date(i.starts_at).toISOString(),ends_at:new Date(i.ends_at).toISOString()})),resolveVenueSchedule(schedule,date,8));
      }
    }
    // Attempt malformed rules directly against SQL, bypassing the TypeScript reader.
    const invalid=[];
    const cyclic=blank();cyclic.weekly[6]=[window(1320,1560)];cyclic.weekly[0]=[window(60,180)];invalid.push(cyclic);
    const spill=blank();spill.weekly[3]=[window(60,180)];spill.exceptions=[{date:'2026-10-06',windows:[window(1320,1560)]}];invalid.push(spill);
    for(const edit of [
      s=>s.weekly.pop(), s=>s.weekly[1].push(window(480,600,-1)),s=>s.weekly[1].push(window(480,600,0.5)),
      s=>s.weekly[1].push(window(480,600,Number.MAX_SAFE_INTEGER+1)),s=>s.weekly[1].push(window(480,500)),
      s=>s.weekly[1].push(window(480,480)),s=>s.weekly[1].push(window(1440,1500)),s=>s.weekly[1].push(window(480,1950)),
      s=>{s.weekly[1]=[window(480,600)];s.weekly[1][0].rates[0].start_minute=510;},
      s=>{s.weekly[1]=[window(480,600)];s.weekly[1][0].rates[0].end_minute=570;},
      s=>{s.weekly[1]=[window(480,600)];s.weekly[1][0].rates[0].actor='spoof';},
      s=>s.exceptions.push({date:'2026-02-29',windows:[]}),
      s=>s.exceptions.push({date:'2026-10-05',windows:[]},{date:'2026-10-05',windows:[]}),
      s=>{s.weekly[1]=Array.from({length:5},(_,i)=>window(i*60,i*60+30));},
      s=>{s.exceptions=Array.from({length:121},()=>({date:'2026-10-05',windows:[]}));},
    ]) {const s=blank();edit(s);invalid.push(s);}
    for(const schedule of invalid) {
      assert.throws(()=>readVenueSchedule(schedule));
      await db.exec('savepoint invalid_rule');
      await assert.rejects(db.query(`select public.venue_schedule_save('61000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000001',$1,$2::jsonb)`,[revision,JSON.stringify(schedule)]),error=>error.code==='22023');
      await db.exec('rollback to invalid_rule; release invalid_rule');
    }
    assert.equal((await db.query(`select revision::text from private.venue_schedules where venue_id='62000000-0000-4000-8000-000000000001'`)).rows[0].revision,revision,'all invalid writes rolled back');
    await db.exec('rollback');
  } finally {await db.close();}
});
