const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {storageStub}=require('./platform.cjs');
async function database(){
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
    return db;
  }catch(error){await db.close();throw error;}
}
test('operations: outside rentals share inventory; attendance and arrival payments are owner-only, retry-safe, audited and never touch status',async()=>{
  const db=await database();
  try {
    await db.exec(fs.readFileSync(path.join(__dirname,'booking-operations.sql'),'utf8'));
    const grants=(await db.query(`select p.proname,r.name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join (values ('anon'),('authenticated'),('service_role')) r(name)
      where n.nspname in ('public','private') and (p.proname like 'booking_operation%' or p.proname like 'rental_booking%')
        and has_function_privilege(r.name,p.oid,'execute') order by 1,2`)).rows;
    assert.deepEqual(grants,['booking_operation','booking_operations_read','rental_booking_change','rental_booking_owner_entry','rental_booking_quote',
      'rental_booking_read','rental_booking_request'].map(proname=>({proname,name:'service_role'})));
    const tables=(await db.query(`select c.relname,c.relrowsecurity,exists(select 1 from (values ('anon'),('authenticated'),('service_role')) r(name)
      where has_table_privilege(r.name,c.oid,'select,insert,update,delete')) api_access from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='private' and c.relname='booking_operations'`)).rows;
    assert.deepEqual(tables,[{relname:'booking_operations',relrowsecurity:true,api_access:false}]);
    assert.equal((await db.query('select count(*)::integer n from private.booking_operations')).rows[0].n,0);
  }finally{await db.close();}
});
