// Real local Docker/PostgREST/Auth and served Edge checks. Never reads hosted/mobile env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const load = require('./load-ts.cjs');

async function main() {
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');
  const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
  const context=run(['context','show']).trim();
  const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const psql=sql=>run(['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],sql).trim();
  run(['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1','-o','/dev/null'],fs.readFileSync(path.join(__dirname,'calendar.sql'),'utf8'));
  console.log('PASS: Docker calendar SQL permissions, court hours, guards, deactivation, overnight, timezone and audit rollback; fixtures rolled back.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback API required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const publicClient=createClient(api.href,config.ANON_KEY,options);
  const check=(result,message)=>{assert.ok(!result.error,message);return result.data;};
  const users=[];const clients=[];const sessions=[];const venue=randomUUID();const courtA=randomUUID();const courtB=randomUUID();let created=false;let child;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-calendar-'));
  const handlerModule=load(path.join(__dirname,'../functions/owner-schedules/handler.ts'),{},{TextDecoder});
  const {createSupabaseScheduleDeps}=load(path.join(__dirname,'../functions/owner-schedules/deps.ts'),{'./handler.ts':handlerModule});
  // Manila date two days ahead; minutes from its midnight.
  const day=offset=>new Date(Date.now()+8*3600000+offset*86400000).toISOString().slice(0,10);
  const at=(minute,offset=2)=>new Date(Date.parse(`${day(offset)}T00:00:00+08:00`)+minute*60000).toISOString();
  const daily=(a,b)=>({weekly:Array.from({length:7},()=>[{start_minute:a,end_minute:b,rates:[{start_minute:a,end_minute:b,hourly_centavos:40000}]}]),exceptions:[]});
  try {
    check(await service.from('venues').insert({id:venue,name:'Local Calendar Fixture',address_line:'1 Fixture',city:'Fixture',province:'Fixture',latitude:14.6,longitude:121,publication_status:'approved',claim_status:'verified'}),'Own fixture venue');created=true;
    check(await service.from('courts').insert([{id:courtA,venue_id:venue,name:'A',status:'active'},{id:courtB,venue_id:venue,name:'B',status:'active'}]),'Own fixture courts');
    for(let i=0;i<3;i++){
      const credentials={email:`calendar-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own user').user.id);
      const client=createClient(api.href,config.ANON_KEY,options);clients.push(client);sessions.push(check(await client.auth.signInWithPassword(credentials),'Own login').session);
    }
    psql(`insert into private.venue_owners(user_id,venue_id) values ('${users[0]}','${venue}');
      insert into private.account_roles(user_id,role) values ('${users[2]}','admin');`);
    const handler=handlerModule.createScheduleHandler({...createSupabaseScheduleDeps(()=>createClient(api.href,config.ANON_KEY,options),()=>createClient(api.href,config.SERVICE_ROLE_KEY,options)),
      limit:async()=>({allowed:true,headers:{}})});
    const post=(who,body)=>handler(new Request('https://schedule.local',{method:'POST',headers:{authorization:`Bearer ${sessions[who].access_token}`,'content-type':'application/json'},body:JSON.stringify(body)}));
    const calendar=async(who,offset=2,days=1)=>handler(new Request(`https://schedule.local?venue_id=${venue}&start_date=${day(offset)}&days=${days}&section=calendar`,{headers:{authorization:`Bearer ${sessions[who].access_token}`}}));
    const block=(who,court,a,b,request=randomUUID())=>post(who,{kind:'block',court_id:court,request_id:request,starts_at:at(a),ends_at:at(b)});
    const revision=()=>psql(`select revision from private.venue_schedules where venue_id='${venue}'`);
    const live=court=>Number(psql(`select count(*) from private.court_allocations where court_id='${court}' and state='active' and (expires_at is null or expires_at>now())`));

    // Hours: venue 06:00-22:00; court A follows them but is closed three days ahead.
    assert.equal((await post(0,{venue_id:venue,expected_revision:null,schedule:daily(360,1320)})).status,200);
    const hoursA=await post(0,{kind:'save_court_hours',court_id:courtA,expected_revision:null,hours:{weekly:null,closures:[day(3)]}});
    assert.equal(hoursA.status,200);assert.equal((await hoursA.json()).revision,'1');
    assert.equal((await post(0,{kind:'save_court_hours',court_id:courtA,expected_revision:null,hours:{weekly:null,closures:[]}})).status,409,'stale court-hours save');
    const view=await (await calendar(0)).json();
    assert.equal(view.courts.length,2);assert.equal(view.schedule_revision,'1');assert.equal(view.courts[0].intervals.length,1);
    assert.equal((await (await calendar(0,3)).json()).courts[0].intervals.length,0,'court closure in calendar');
    assert.equal((await block(0,courtA,600,660,undefined).then(r=>r.status)),200);
    assert.equal((await post(0,{kind:'block',court_id:courtA,request_id:randomUUID(),starts_at:at(600,3),ends_at:at(660,3)})).status,409,'closed court date refuses blocks');

    // Concurrent blocks: overlapping requests yield one winner; identical retries create one row.
    const overlapping=await Promise.all([0,30,60,0,30,60].map(shift=>block(0,courtB,480+shift,570+shift)));
    assert.deepEqual(overlapping.map(r=>r.status).sort(),[200,409,409,409,409,409]);
    const retryId=randomUUID();const retries=await Promise.all(Array.from({length:6},()=>block(0,courtB,720,780,retryId)));
    assert.ok(retries.every(r=>r.status===200));
    assert.deepEqual((await Promise.all(retries.map(r=>r.json()))).map(r=>r.outcome).sort(),['created','existing','existing','existing','existing','existing']);
    assert.equal(psql(`select count(*) from private.court_allocations where request_id='${retryId}'`),'1');
    console.log('PASS: real Auth + shipped handler/PostgREST: court hours, closures, calendar read, overlapping blocks (one winner) and retries (one row).');

    // Race: a schedule save that closes 18:00-22:00 against a block at 19:00. Never both.
    const wins={save:0,block:0};
    for(let round=0;round<4;round++){
      const [save,blocked]=await Promise.all([post(0,{venue_id:venue,expected_revision:revision(),schedule:daily(360,1080)}),block(0,courtA,1140,1200)]);
      const outcome=[[save.status,(await save.json()).error??null],[blocked.status,(await blocked.json()).error??null]];
      if(outcome[0][0]===200){wins.save++;assert.deepEqual(outcome[1],[409,'outside_hours']);
        assert.equal((await post(0,{venue_id:venue,expected_revision:revision(),schedule:daily(360,1320)})).status,200);}
      else{wins.block++;assert.deepEqual(outcome[0],[409,'hours_conflict']);assert.equal(outcome[1][0],200);
        const id=psql(`select id from private.court_allocations where court_id='${courtA}' and starts_at='${at(1140)}' and state='active'`);
        assert.equal((await post(0,{kind:'release_block',allocation_id:id})).status,200);}
    }
    // Race: court deactivation (T18 command) against a block on that court. Never both.
    const deactivations={court:0,block:0};
    const courtSave=async status=>{const updated=psql(`select updated_at from public.venues where id='${venue}'`);
      return service.rpc('owner_venue_save',{actor_user_id:users[0],target_venue_id:venue,expected_updated_at:updated,
        venue_input:{name:'Local Calendar Fixture',address_line:'1 Fixture',city:'Fixture',province:'Fixture'},
        court_inputs:[{id:courtB,name:'B',surface:null,is_indoor:false,is_covered:false,status}]});};
    const releaseB=()=>psql(`update private.court_allocations set state='released',ended_at=clock_timestamp() where court_id='${courtB}' and state='active';`);
    releaseB();
    for(let round=0;round<4;round++){
      // Alternate rounds give the slower authenticated block a head start, so both orders occur.
      const delay=round%2?new Promise(resolve=>setTimeout(resolve,250)):Promise.resolve();
      const [deactivated,blocked]=await Promise.all([delay.then(()=>courtSave('inactive')),block(0,courtB,900,960)]);
      if(!deactivated.error){deactivations.court++;assert.equal(blocked.status,404);assert.equal((await blocked.json()).error,'court_unavailable');
        assert.ok(!(await courtSave('active')).error);}
      else{deactivations.block++;assert.equal(deactivated.error.hint,'court_allocated');assert.equal(blocked.status,200);releaseB();}
    }
    console.log(`PASS: concurrent schedule-save/block (save won ${wins.save}, block won ${wins.block}) and deactivation/block (deactivation won ${deactivations.court}, block won ${deactivations.block}) never both succeed.`);

    // Guards through the real API: displacement and deactivation are refused with actionable errors.
    assert.equal((await block(0,courtB,900,960)).status,200);
    const displaced=await post(0,{venue_id:venue,expected_revision:revision(),schedule:daily(360,840)});
    assert.equal(displaced.status,409);assert.equal((await displaced.json()).error,'hours_conflict');
    assert.equal((await courtSave('inactive')).error?.hint,'court_allocated');
    // Managed inventory (a trusted rental hold) can't be released from the calendar.
    psql(`select private.allocation_acquire('${courtB}','rental','${at(1200)}','${at(1260)}',clock_timestamp()+interval '1 hour','${users[1]}','${randomUUID()}');`);
    const rental=psql(`select id from private.court_allocations where court_id='${courtB}' and kind='rental'`);
    assert.equal((await post(0,{kind:'release_block',allocation_id:rental})).status,403);
    const shown=await (await calendar(0)).json();
    assert.ok(shown.allocations.some(a=>a.kind==='rental'&&a.expires_at!==null),'live hold shown');
    // Permissions: other players, direct RPC calls and revoked owners.
    assert.equal((await calendar(1)).status,403);assert.equal((await block(1,courtA,600,660)).status,403);
    assert.equal((await post(1,{kind:'save_court_hours',court_id:courtA,expected_revision:'1',hours:{weekly:null,closures:[]}})).status,403);
    assert.equal((await calendar(2)).status,200,'admin reads');
    for(const client of [clients[0],publicClient]){
      assert.equal((await client.rpc('owner_calendar_read',{actor_user_id:users[0],target_venue_id:venue,start_date:day(2),days:1})).error?.code,'42501');
      assert.equal((await client.rpc('court_hours_save',{actor_user_id:users[0],target_court_id:courtA,expected_revision:'1',hours_input:{weekly:null,closures:[]}})).error?.code,'42501');
    }
    const audits=psql(`select string_agg(action||':'||n,',' order by action) from (select action,count(*) n from private.directory_audit_events where target_venue_id='${venue}' and action like 'schedule.%' group by action) x`);
    assert.match(audits,/^schedule\.court_update:1,schedule\.update:\d+$/);
    psql(`delete from private.venue_owners where venue_id='${venue}';`);
    assert.equal((await calendar(0)).status,403);assert.equal((await block(0,courtA,1260,1320)).status,403);
    psql(`insert into private.venue_owners(user_id,venue_id) values ('${users[0]}','${venue}');`);
    console.log('PASS: displacement/deactivation refusals, managed-hold protection, player/RPC bypass denial, admin read, one audit per save and revocation.');

    // Actual Edge Runtime: no Redis configured; bounded reads may continue, inventory writes must fail closed.
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
    assert.ok(ready,'Local Edge ready');
    const forged=`${sessions[0].access_token.split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[0],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await invoke(forged,`?venue_id=${venue}&start_date=${day(2)}&days=1&section=calendar`)).status,401);
    const served=await invoke(sessions[0].access_token,`?venue_id=${venue}&start_date=${day(2)}&days=1&section=calendar`);
    assert.equal(served.status,200);assert.equal((await served.json()).courts.length,2);
    const before=live(courtA);
    const refused=await invoke(sessions[0].access_token,'',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({kind:'block',court_id:courtA,request_id:randomUUID(),starts_at:at(1260),ends_at:at(1320)})});
    assert.equal(refused.status,503);assert.equal(refused.headers.get('retry-after'),'5');assert.equal(live(courtA),before);
    console.log('PASS: served Edge forged-JWT denial, bounded calendar read, Redis-outage block denial with unchanged inventory.');
  } finally {
    if(child&&child.exitCode===null)child.kill();let clean=true;
    const steps=[];if(created)steps.push(async()=>check(await service.from('venues').delete().eq('id',venue),'Own venue cleanup'));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own account cleanup'));
    steps.push(()=>psql(`delete from private.directory_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-calendar-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const client of [service,publicClient,...clients])steps.push(()=>client.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}
    assert.ok(clean,'Own fixtures/temp removed');
    assert.equal(psql(`select (select count(*) from private.venue_schedules where venue_id='${venue}')+(select count(*) from private.court_schedules where court_id in ('${courtA}','${courtB}'))
      +(select count(*) from private.court_allocations where venue_id='${venue}')+(select count(*) from private.directory_audit_events where target_venue_id='${venue}')`),'0');
  }
  console.log('PASS: own fixtures/allocations/audit/env removed; only own child stopped; no hosted changes.');
}
main().catch(error=>{console.error(`Local calendar check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);process.exitCode=1;});
