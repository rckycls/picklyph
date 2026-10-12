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
test('storage sweep: due evidence and unreferenced objects only, purges recorded once the object is gone, reviewers see removed evidence, and the monitor counts a backlog',async()=>{
  const db=await database();
  try {
    await db.exec(fs.readFileSync(path.join(__dirname,'storage-sweep.sql'),'utf8'));
    // Rolled back: no fixtures remain.
    assert.equal((await db.query(`select count(*)::int n from storage.objects where name like '%/ce400000-%'`)).rows[0].n,0);
    assert.equal((await db.query(`select to_regnamespace('storage_test') is null gone`)).rows[0].gone,true);
    // Without pg_cron and Vault (as on an unprepared project) scheduling and the kick fail loudly.
    await assert.rejects(db.query('select private.storage_sweep_schedule()'),/cron/);
    await assert.rejects(db.query('select private.storage_sweep_kick()'),/vault/);
  }finally{await db.close();}
});
