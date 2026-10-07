const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {storageStub}=require('./platform.cjs');
const {readCourtHours,resolveCourtHours}=require('../../packages/domain/src/calendar.ts');

test('court hours, calendar and displacement guards: permissions, rollback and SQL/TypeScript parity on PostgreSQL/PostGIS',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');
  const {postgis}=await import('@electric-sql/pglite-postgis');
  const {pg_trgm}=await import('@electric-sql/pglite/contrib/pg_trgm');
  const {btree_gist}=await import('@electric-sql/pglite/contrib/btree_gist');
  const db=new PGlite({extensions:{postgis,pg_trgm,btree_gist}});
  try{
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; $$; ${storageStub}`);
    for(const file of fs.readdirSync(path.join(__dirname,'../migrations')).filter(f=>f.endsWith('.sql')).sort())
      await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname,'calendar.sql'),'utf8'));
    const grants=(await db.query(`select p.proname,r.name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join (values ('anon'),('authenticated'),('service_role')) r(name)
      where n.nspname in ('public','private') and (p.proname like 'court_%' or p.proname like '%calendar%' or p.proname like '%hours%'
        or p.proname like 'allocation%' or p.proname='guard_court_deactivation')
      and has_function_privilege(r.name,p.oid,'execute') order by 1,2`)).rows;
    assert.deepEqual(grants,['court_allocation_block','court_allocation_read','court_allocation_release','court_hours_save','owner_calendar_read']
      .map(proname=>({proname,name:'service_role'})));
    const tables=(await db.query(`select c.relname,c.relrowsecurity,exists(select 1 from (values ('anon'),('authenticated'),('service_role')) r(name)
      where has_table_privilege(r.name,c.oid,'select,insert,update,delete')) as api_access
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
      and c.relname in ('court_schedules','court_hours','court_closures') order by 1`)).rows;
    assert.deepEqual(tables,['court_closures','court_hours','court_schedules'].map(relname=>({relname,relrowsecurity:true,api_access:false})));
    assert.equal((await db.query(`select count(*)::integer as n from pg_proc where proname='allocation_within_hours'`)).rows[0].n,0,'venue-wide check replaced');
    assert.equal((await db.query('select count(*)::integer as n from private.court_schedules')).rows[0].n,0,'suite rolled back');

    // Parity: the same venue/court rules resolved by SQL and TypeScript.
    await db.exec(`begin; insert into auth.users(id) values ('86000000-0000-4000-8000-000000000003');
      insert into private.account_roles(user_id,role) values ('86000000-0000-4000-8000-000000000003','admin');
      insert into public.venues(id,name,address_line,city,province,latitude,longitude) values
      ('87000000-0000-4000-8000-000000000001','Parity','Fixture','Manila','Metro Manila',14.6,121);
      insert into public.courts(id,venue_id,name,status) values ('88000000-0000-4000-8000-000000000001','87000000-0000-4000-8000-000000000001','P','active');`);
    const band=(a,b,c=25000)=>({start_minute:a,end_minute:b,rates:[{start_minute:a,end_minute:b,hourly_centavos:c}]});
    const venue={weekly:Array.from({length:7},(_,d)=>d===6?[band(1320,1560)]:[{start_minute:360,end_minute:1320,rates:[
      {start_minute:360,end_minute:1020,hourly_centavos:40000},{start_minute:1020,end_minute:1320,hourly_centavos:60000}]}]),
      exceptions:[{date:'2026-10-05',windows:[]},{date:'2026-10-07',windows:[band(60,180,30000)]}]};
    await db.query(`select public.venue_schedule_save('86000000-0000-4000-8000-000000000003','87000000-0000-4000-8000-000000000001',null,$1::jsonb)`,[JSON.stringify(venue)]);
    const every=windows=>Array.from({length:7},()=>windows);
    const samples=[{weekly:null,closures:[]},{weekly:null,closures:['2026-10-04','2026-10-08']},
      {weekly:every([{start_minute:480,end_minute:720},{start_minute:960,end_minute:1200}]),closures:['2026-10-06']},
      {weekly:every([{start_minute:0,end_minute:60},{start_minute:1380,end_minute:1440}]),closures:[]},
      {weekly:every([{start_minute:0,end_minute:1440}]),closures:['2026-10-03']},
      {weekly:every([]),closures:[]}];
    // Deterministic per-weekday windows exercise each day and the rate split at 17:00.
    for(let n=0;n<7;n++)samples.push({weekly:Array.from({length:7},(_,d)=>d===n?[{start_minute:960+n*30,end_minute:1080+n*30}]:[{start_minute:0,end_minute:30*(n+1)}]),closures:[]});
    let revision=null;
    for(const hours of samples){
      const view=(await db.query(`select public.court_hours_save('86000000-0000-4000-8000-000000000003','88000000-0000-4000-8000-000000000001',$1,$2::jsonb) as view`,
        [revision,JSON.stringify(hours)])).rows[0].view;
      revision=view.revision;assert.deepEqual(view.hours,readCourtHours(hours));
      for(const date of ['2026-10-02','2026-10-08']){
        const sql=(await db.query(`select private.resolve_court_hours('88000000-0000-4000-8000-000000000001',$1::date,7) as intervals`,[date])).rows[0].intervals;
        assert.deepEqual(sql.map(i=>({...i,starts_at:new Date(i.starts_at).toISOString(),ends_at:new Date(i.ends_at).toISOString()})),resolveCourtHours(venue,hours,date,7));
      }
    }
    await db.exec('rollback');
  }finally{await db.close();}
});
