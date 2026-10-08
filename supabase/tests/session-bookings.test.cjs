const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {storageStub}=require('./platform.cjs');
test('group bookings: locked spot capacity, names/limits, holds without cron, retries, access and event rollback',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');
  const {postgis}=await import('@electric-sql/pglite-postgis');
  const {pg_trgm}=await import('@electric-sql/pglite/contrib/pg_trgm');
  const {btree_gist}=await import('@electric-sql/pglite/contrib/btree_gist');
  const db=new PGlite({extensions:{postgis,pg_trgm,btree_gist}});
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;grant usage on schema auth to anon,authenticated,service_role;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; $$;${storageStub}`);
    for(const file of fs.readdirSync(path.join(__dirname,'../migrations')).filter(f=>f.endsWith('.sql')).sort())
      await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname,'session-bookings.sql'),'utf8'));
    const grants=(await db.query(`select p.proname,r.name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join (values ('anon'),('authenticated'),('service_role')) r(name)
      where n.nspname in ('public','private') and p.proname like 'session%' and has_function_privilege(r.name,p.oid,'execute') order by 1,2`)).rows;
    assert.deepEqual(grants,['session_booking_change','session_booking_read','session_booking_request'].map(proname=>({proname,name:'service_role'})));
    const tables=(await db.query(`select c.relname,c.relrowsecurity,exists(select 1 from (values ('anon'),('authenticated'),('service_role')) r(name)
      where has_table_privilege(r.name,c.oid,'select,insert,update,delete')) api_access from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relname in ('session_bookings','session_booking_events') order by 1`)).rows;
    assert.deepEqual(tables,['session_booking_events','session_bookings'].map(relname=>({relname,relrowsecurity:true,api_access:false})));
    assert.equal((await db.query('select count(*)::integer n from private.session_bookings')).rows[0].n,0);
  }finally{await db.close();}
});
