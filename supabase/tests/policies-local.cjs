// Local Docker/Auth/PostgREST/mobile client/Edge. Never reads hosted/mobile env.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const {createClient}=require('@supabase/supabase-js');
const load=require('./load-ts.cjs');
const {loadVenuePolicy,saveVenuePolicy}=require('../../src/features/owner/venueClient.ts');
async function main(){
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');
  const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
  const context=run(['context','show']).trim();
  const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const psql=sql=>run(['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],sql).trim();
  run(['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1','-o','/dev/null'],fs.readFileSync(path.join(__dirname,'policies.sql'),'utf8'));
  console.log('PASS: Docker policy SQL defaults, permissions, inactive/active merchant, revocation, stale versions and audit rollback; fixtures rolled back.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const guest=createClient(api.href,config.ANON_KEY,options);
  const check=(result,message)=>{assert.ok(!result.error,message);return result.data;};
  const users=[],clients=[],sessions=[];const venue=randomUUID();let created=false;let child;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-policies-'));
  const handlerModule=load(path.join(__dirname,'../functions/owner-venues/handler.ts'),{},{TextDecoder,DataView});
  const {createSupabaseVenueDeps}=load(path.join(__dirname,'../functions/owner-venues/deps.ts'),{'./handler.ts':handlerModule});
  try{
    check(await service.from('venues').insert({id:venue,name:'Local Policy Fixture',address_line:'Fixture',city:'Fixture',province:'Fixture',latitude:14.6,longitude:121,publication_status:'approved',claim_status:'verified'}),'Own fixture');created=true;
    for(let i=0;i<2;i++){
      const credentials={email:`policy-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own user').user.id);
      const client=createClient(api.href,config.ANON_KEY,options);clients.push(client);sessions.push(check(await client.auth.signInWithPassword(credentials),'Own login').session);
    }
    psql(`insert into private.venue_owners(user_id,venue_id) values ('${users[0]}','${venue}');`);
    const handler=handlerModule.createVenueHandler({...createSupabaseVenueDeps(()=>createClient(api.href,config.ANON_KEY,options),()=>createClient(api.href,config.SERVICE_ROLE_KEY,options)),limit:async()=>({allowed:true,headers:{}}),newId:randomUUID});
    const transport=who=>({endpoint:'https://local/owner-venues',apiKey:config.ANON_KEY,accessToken:async()=>sessions[who].access_token,fetch:(url,init)=>handler(new Request(url,init))});
    const command={kind:'save_policy',venue_id:venue,expected_revision:'0',policy:{confirmation:'approval',payment:'arrival'}};
    const ok=result=>{assert.ok(result.ok,result.failure?.reason||result.failure?.kind);return result.value;};
    assert.deepEqual(ok(await loadVenuePolicy(transport(0),venue)),{venue_id:venue,revision:'0',confirmation:'instant',payment:'arrival',merchant_active:false});
    assert.equal((await saveVenuePolicy(transport(1),command)).failure.reason,'not_owner');
    assert.equal((await saveVenuePolicy(transport(0),{...command,policy:{confirmation:'instant',payment:'both'}})).failure.reason,'merchant_inactive');
    const race=await Promise.all([saveVenuePolicy(transport(0),command),saveVenuePolicy(transport(0),command)]);
    assert.equal(race.filter(r=>r.ok).length,1);assert.equal(race.find(r=>!r.ok).failure.reason,'version_conflict');
    assert.equal(psql(`select count(*) from private.directory_audit_events where target_venue_id='${venue}' and action='policy.update'`),'1');
    assert.equal(psql(`select bool_and(actor_user_id='${users[0]}'::uuid) from private.directory_audit_events where target_venue_id='${venue}'`),'t');
    assert.equal((await clients[0].rpc('owner_venue_policy_save',{actor_user_id:users[0],target_venue_id:venue,expected_revision:'1',policy_input:command.policy})).error?.code,'42501');
    assert.equal((await guest.rpc('owner_venue_policy_read',{actor_user_id:users[0],target_venue_id:venue})).error?.code,'42501');
    psql(`insert into private.venue_merchants(venue_id,active) values ('${venue}',true);`);
    assert.equal(ok(await saveVenuePolicy(transport(0),{...command,expected_revision:'1',policy:{confirmation:'instant',payment:'online'}})).payment,'online');
    assert.equal(ok(await saveVenuePolicy(transport(0),{...command,expected_revision:'2',policy:{confirmation:'approval',payment:'both'}})).payment,'both');
    psql(`update private.venue_merchants set active=false where venue_id='${venue}';`);
    assert.equal(ok(await loadVenuePolicy(transport(0),venue)).payment,'arrival');
    psql(`delete from private.venue_owners where venue_id='${venue}';`);
    assert.equal((await saveVenuePolicy(transport(0),{...command,expected_revision:'3'})).failure.reason,'not_owner');
    psql(`insert into private.venue_owners(user_id,venue_id) values ('${users[0]}','${venue}');`);
    console.log('PASS: real Auth + shipped mobile client/handler/PostgREST: one concurrent success/one conflict, one actor audit, activated online/both, activation loss, revocation and RPC bypass denial.');
    const envPath=path.join(temp,'functions.env');
    fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\n`);
    child=spawn(cli,['functions','serve','owner-venues','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
    let launchError=false;child.on('error',()=>{launchError=true;});
    const endpoint=new URL('functions/v1/owner-venues',api).href;
    const invoke=(token,tail='',init={})=>fetch(endpoint+tail,{...init,headers:{apikey:config.ANON_KEY,...(token?{authorization:`Bearer ${token}`}:{ }),...init.headers},signal:AbortSignal.timeout(8000)});
    let ready=false;for(let n=0;n<90;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');try{if((await invoke(null)).status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
    assert.ok(ready,'Edge ready');assert.equal((await invoke('forged')).status,401);
    const forged=`${sessions[0].access_token.split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[0],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await invoke(forged)).status,401);
    const read=await invoke(sessions[0].access_token,`?venue_id=${venue}&section=policies`);assert.equal(read.status,200);assert.equal((await read.json()).policy.revision,'3');
    const rejected=await invoke(sessions[0].access_token,'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...command,expected_revision:'3'})});
    assert.equal(rejected.status,503);assert.equal(rejected.headers.get('retry-after'),'5');
    assert.equal(psql(`select revision from private.venue_policies where venue_id='${venue}'`),'3');
    assert.equal(psql(`select count(*) from private.directory_audit_events where target_venue_id='${venue}' and action='policy.update'`),'3');
    console.log('PASS: served Edge forged-token denial, bounded policy read and Redis-outage save denial with unchanged version/audit.');
  }finally{
    if(child&&child.exitCode===null)child.kill();let clean=true;
    const steps=[];if(created)steps.push(async()=>check(await service.from('venues').delete().eq('id',venue),'Own venue cleanup'));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own user cleanup'));
    steps.push(()=>psql(`delete from private.directory_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-policies-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const client of [service,guest,...clients])steps.push(()=>client.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/temp removed');
    assert.equal(psql(`select (select count(*) from private.venue_policies where venue_id='${venue}')+(select count(*) from private.venue_merchants where venue_id='${venue}')+(select count(*) from private.directory_audit_events where target_venue_id='${venue}')`),'0');
  }
  console.log('PASS: own fixtures/audit/temp credentials removed; only own child stopped; no hosted changes.');
}
main().catch(error=>{console.error(`Local policy check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);process.exitCode=1;});
