// Real local Docker/PostgREST/Auth and served Edge checks. Never reads hosted/mobile env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const load = require('./load-ts.cjs');
const { resolveVenueSchedule } = require('../../packages/domain/src/schedule.ts');

async function main() {
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');
  const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
  const context=run(['context','show']).trim();
  const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const psql=sql=>run(['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],sql).trim();
  run(['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1','-o','/dev/null'],fs.readFileSync(path.join(__dirname,'schedules.sql'),'utf8'));
  console.log('PASS: Docker schedule SQL permissions, rates, versions, timezone and audit rollback; fixtures rolled back.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback API required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const publicClient=createClient(api.href,config.ANON_KEY,options);
  const check=(result,message)=>{assert.ok(!result.error,message);return result.data;};
  const users=[];const clients=[];const sessions=[];const venue=randomUUID();let created=false;let child;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-schedules-'));
  const handlerModule=load(path.join(__dirname,'../functions/owner-schedules/handler.ts'),{},{TextDecoder});
  const {createSupabaseScheduleDeps}=load(path.join(__dirname,'../functions/owner-schedules/deps.ts'),{'./handler.ts':handlerModule});
  try {
    check(await service.from('venues').insert({id:venue,name:'Local Schedule Fixture',address_line:'1 Fixture',city:'Fixture',province:'Fixture',latitude:14.6,longitude:121,publication_status:'approved',claim_status:'verified'}),'Own fixture venue');created=true;
    for(let i=0;i<3;i++){
      const credentials={email:`schedule-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own user').user.id);
      const client=createClient(api.href,config.ANON_KEY,options);clients.push(client);sessions.push(check(await client.auth.signInWithPassword(credentials),'Own login').session);
    }
    psql(`insert into private.venue_owners(user_id,venue_id) values ('${users[0]}','${venue}');
      insert into private.account_roles(user_id,role) values ('${users[2]}','admin');`);
    const handler=handlerModule.createScheduleHandler({...createSupabaseScheduleDeps(()=>createClient(api.href,config.ANON_KEY,options),()=>createClient(api.href,config.SERVICE_ROLE_KEY,options)),
      limit:async()=>({allowed:true,headers:{}})});
    const schedule={weekly:Array.from({length:7},()=>[]),exceptions:[]};
    schedule.weekly[1]=[{start_minute:1320,end_minute:1560,rates:[{start_minute:1320,end_minute:1560,hourly_centavos:25000}]}];
    const command={venue_id:venue,expected_revision:null,schedule};
    const call=(who,body=command)=>handler(new Request('https://schedule.local',{method:'POST',headers:{authorization:`Bearer ${sessions[who].access_token}`,'content-type':'application/json'},body:JSON.stringify(body)}));
    assert.equal((await call(1)).status,403);
    const race=await Promise.all([call(0),call(0)]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
    assert.equal(psql(`select count(*) from private.directory_audit_events where target_venue_id='${venue}' and action='schedule.update'`),'1');
    const query=`venue_id=${venue}&start_date=2026-10-05&days=2`;
    const read=await handler(new Request('https://schedule.local?'+query,{headers:{authorization:`Bearer ${sessions[0].access_token}`}}));
    const view=await read.json();assert.equal(view.revision,'1');
    assert.deepEqual(view.intervals.map(i=>({...i,starts_at:new Date(i.starts_at).toISOString(),ends_at:new Date(i.ends_at).toISOString()})),resolveVenueSchedule(schedule,'2026-10-05',2));
    assert.equal((await call(2,{...command,expected_revision:'1'})).status,200);
    assert.equal((await clients[0].rpc('venue_schedule_save',{actor_user_id:users[0],target_venue_id:venue,expected_revision:'2',schedule_input:schedule})).error?.code,'42501');
    assert.equal((await publicClient.rpc('venue_schedule_read',{actor_user_id:users[0],target_venue_id:venue,start_date:'2026-10-05',days:2})).error?.code,'42501');
    psql(`delete from private.venue_owners where venue_id='${venue}';`);assert.equal((await call(0,{...command,expected_revision:'2'})).status,403);
    psql(`delete from private.account_roles where user_id='${users[2]}';`);assert.equal((await call(2,{...command,expected_revision:'2'})).status,403);
    psql(`insert into private.venue_owners(user_id,venue_id) values ('${users[0]}','${venue}');`);
    console.log('PASS: real Auth + shipped handler/PostgREST saves, owner/admin permissions, revocation, RPC bypass denial, concurrent 200/409 and one audit.');
    // Actual Edge Runtime: no Redis configured; bounded reads may continue, writes must fail closed.
    const envPath=path.join(temp,'functions.env');
    fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\n`);
    child=spawn(cli,['functions','serve','owner-schedules','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const endpoint=new URL('functions/v1/owner-schedules',api).href;
    const invoke=(token,tail='',init={})=>fetch(endpoint+tail,{...init,headers:{apikey:config.ANON_KEY,...(token?{authorization:`Bearer ${token}`}:{ }),...init.headers},signal:AbortSignal.timeout(8000)});
    let ready=false;for(let n=0;n<90;n++){
      assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{if((await invoke(null)).status===401){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.ok(ready,'Local Edge ready');assert.equal((await invoke('forged')).status,401);
    const forged=`${sessions[0].access_token.split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[0],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await invoke(forged)).status,401);
    assert.equal((await invoke(sessions[0].access_token,'?'+query)).status,200);
    const refused=await invoke(sessions[0].access_token,'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...command,expected_revision:'2'})});
    assert.equal(refused.status,503);assert.equal(refused.headers.get('retry-after'),'5');
    assert.equal(psql(`select revision from private.venue_schedules where venue_id='${venue}'`),'2');
    assert.equal(psql(`select count(*) from private.directory_audit_events where target_venue_id='${venue}' and action='schedule.update'`),'2');
    console.log('PASS: served Edge forged-JWT denial, bounded read, Redis-outage write denial with unchanged revision/audit.');
  } finally {
    if(child&&child.exitCode===null)child.kill();let clean=true;
    const steps=[];if(created)steps.push(async()=>check(await service.from('venues').delete().eq('id',venue),'Own venue cleanup'));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own account cleanup'));
    steps.push(()=>psql(`delete from private.directory_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-schedules-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const client of [service,publicClient,...clients])steps.push(()=>client.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}
    assert.ok(clean,'Own fixtures/temp removed');
    assert.equal(psql(`select (select count(*) from private.venue_schedules where venue_id='${venue}')+(select count(*) from private.directory_audit_events where target_venue_id='${venue}')`),'0');
  }
  console.log('PASS: own fixtures/audit/env removed; only own child stopped; no hosted changes.');
}
main().catch(error=>{console.error(`Local schedule check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);process.exitCode=1;});
