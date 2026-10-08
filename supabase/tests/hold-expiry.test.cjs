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
test('hold expiry: bounded sweeps record each elapsed rental and group hold once, never revive, and isolate failures',async()=>{
  const db=await database();
  try {
    await db.exec(fs.readFileSync(path.join(__dirname,'hold-expiry.sql'),'utf8'));
    // Without pg_cron (as on unprepared hosted projects) the migration schedules nothing and the helper fails loudly.
    await assert.rejects(db.query('select private.booking_expiry_schedule()'),/cron/);
    const indexes=(await db.query(`select indexname from pg_indexes where schemaname='private' and indexname like '%\\_once' order by 1`)).rows.map(r=>r.indexname);
    assert.deepEqual(indexes,['rental_events_once','session_booking_events_once']);
  }finally{await db.close();}
});
