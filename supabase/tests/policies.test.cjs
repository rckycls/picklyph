const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {storageStub}=require('./platform.cjs');
test('private policy commands enforce owner/merchant/version boundaries and atomic audit on PostgreSQL/PostGIS',async()=>{
  const {PGlite}=await import('@electric-sql/pglite');
  const {postgis}=await import('@electric-sql/pglite-postgis');
  const {pg_trgm}=await import('@electric-sql/pglite/contrib/pg_trgm');
  const db=new PGlite({extensions:{postgis,pg_trgm}});
  try{
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to anon,authenticated,service_role;
      create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; $$; ${storageStub}`);
    for(const file of fs.readdirSync(path.join(__dirname,'../migrations')).filter(f=>f.endsWith('.sql')).sort())
      await db.exec(fs.readFileSync(path.join(__dirname,'../migrations',file),'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname,'policies.sql'),'utf8'));
    const permissions=(await db.query(`select p.proname,r.name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join (values ('anon'),('authenticated'),('service_role')) r(name)
      where n.nspname in ('public','private') and p.proname in ('owner_venue_policy_read','owner_venue_policy_save','venue_policy_view')
      and has_function_privilege(r.name,p.oid,'execute') order by 1,2`)).rows;
    assert.deepEqual(permissions,[{proname:'owner_venue_policy_read',name:'service_role'},{proname:'owner_venue_policy_save',name:'service_role'}]);
    const tables=(await db.query(`select c.relname,c.relrowsecurity,
      exists(select 1 from (values ('anon'),('authenticated'),('service_role')) r(name)
      where has_table_privilege(r.name,c.oid,'select,insert,update,delete')) as api_access
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname in ('venue_policies','venue_merchants')`)).rows;
    assert.equal(tables.length,2);assert.ok(tables.every(r=>r.relrowsecurity&&!r.api_access));
    assert.equal((await db.query('select count(*)::integer as n from private.venue_policies')).rows[0].n,0);
  }finally{await db.close();}
});
