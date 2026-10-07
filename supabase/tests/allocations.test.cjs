const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {storageStub}=require('./platform.cjs');
test('court allocations: overlap/adjacency, retries, holds, permissions and rollback on PostgreSQL/PostGIS',async()=>{
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
    await db.exec(fs.readFileSync(path.join(__dirname,'allocations.sql'),'utf8'));
    const permissions=(await db.query(`select p.proname,r.name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join (values ('anon'),('authenticated'),('service_role')) r(name)
      where n.nspname in ('public','private') and (p.proname like 'allocation%' or p.proname like 'court_allocation%')
      and has_function_privilege(r.name,p.oid,'execute') order by 1,2`)).rows;
    assert.deepEqual(permissions,['court_allocation_block','court_allocation_read','court_allocation_release'].map(proname=>({proname,name:'service_role'})));
    const table=(await db.query(`select c.relrowsecurity,exists(select 1 from (values ('anon'),('authenticated'),('service_role')) r(name)
      where has_table_privilege(r.name,c.oid,'select,insert,update,delete')) as api_access
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='court_allocations'`)).rows;
    assert.deepEqual(table,[{relrowsecurity:true,api_access:false}]);
    assert.equal((await db.query('select count(*)::integer as n from private.court_allocations')).rows[0].n,0,'suite rolled back');
  }finally{await db.close();}
});
