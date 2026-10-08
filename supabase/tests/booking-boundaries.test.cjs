const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {test}=require('node:test');
const {storageStub}=require('./platform.cjs');
const mutations=require('./booking-boundaries-mutations.cjs');
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
test('arrival boundaries: cancellation, no-show and 24-hour cutoff at exact instants follow locked snapshots; every boundary mutation is caught',async()=>{
  const db=await database();
  try {
    const suite=fs.readFileSync(path.join(__dirname,'booking-boundaries.sql'),'utf8');
    const definitions=async()=>(await db.query(`select md5(string_agg(pg_get_functiondef(p.oid),'' order by p.oid)) d from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'`)).rows[0].d;
    const real=await definitions();
    await db.exec(suite);
    // The frozen clock lived only inside the suite's transaction.
    assert.equal(await definitions(),real);
    assert.equal((await db.query(`select count(*)::integer n from pg_namespace where nspname='bound_test'`)).rows[0].n,0);
    for(const [fn,from,to,caught] of mutations){
      const def=(await db.query('select pg_get_functiondef($1::regprocedure) d',[fn])).rows[0].d;
      assert.equal(def.split(from).length,2,`${fn} contains the mutated text once`);
      await db.exec('begin;');await db.exec(def.replace(from,to));
      await assert.rejects(db.exec(suite),caught,`${fn}: ${to}`);
      await db.exec('rollback;');
    }
    assert.equal(await definitions(),real);
  }finally{await db.close();}
});
