// Real local Docker/Auth/PostgREST, independent lock sessions and served Edge. No hosted/mobile env.
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {randomUUID}=require('node:crypto');const {execFileSync,spawn}=require('node:child_process');const {createClient}=require('@supabase/supabase-js');
const load=require('./load-ts.cjs');
async function main(){
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
  const context=run(['context','show']).trim();const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const args=['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'];
  const sql=query=>run(args,query).trim();const literal=value=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`;
  const inventory=()=>sql(`select jsonb_build_object('venues',(select jsonb_agg(id order by id) from public.venues),
    'users',(select jsonb_agg(id order by id) from auth.users),'allocations',(select jsonb_agg(id order by id) from private.court_allocations),
    'sessions',(select jsonb_agg(id order by id) from private.open_play_sessions),'audit',(select jsonb_agg(id order by id) from private.directory_audit_events));`);
  const beforeInventory=inventory();
  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'sessions.sql'),'utf8'));
  console.log('PASS: Docker session SQL permissions, all-court rollback, rental overlap, snapshots, retries, suspension, guards and audit rollback.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(r,message)=>{assert.ok(!r.error,message);return r.data;};const users=[],clients=[],tokens=[];const venue=randomUUID();const courts=[randomUUID(),randomUUID()].sort();let created=false;let child;
  const workers=new Set();const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-sessions-'));
  const dbSession=query=>new Promise(resolve=>{
    const worker=spawn(docker,args,{windowsHide:true});workers.add(worker);let out='',err='';
    worker.stdout.on('data',d=>out+=d);worker.stderr.on('data',d=>err+=d);
    worker.on('error',()=>resolve({code:-1,out,err}));worker.on('close',code=>{workers.delete(worker);resolve({code,out:out.trim(),err});});worker.stdin.end(query);
  });
  const domain={...require('../../packages/domain/src/session.ts'),...require('../../packages/domain/src/booking.ts'),...require('../../packages/domain/src/calendar.ts')};
  const imports={'@picklyph/domain':domain,'./venueClient':require('../../src/features/owner/venueClient.ts')};
  imports['./calendarClient']=load(path.resolve('src/features/owner/calendarClient.ts'),imports);
  const mobile=load(path.resolve('src/features/owner/sessionClient.ts'),imports);const {createSessionJournal}=load(path.resolve('src/features/owner/sessionAttempt.ts'),imports);
  const handlerModule=load(path.join(__dirname,'../functions/owner-sessions/handler.ts'),{},{TextDecoder});
  const {createSupabaseSessionDeps}=load(path.join(__dirname,'../functions/owner-sessions/deps.ts'),{'./handler.ts':handlerModule});
  const {createSessionHandler}=handlerModule;
  const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();
  const input=(a,b,courtIds=courts,request=randomUUID())=>({venue_id:venue,request_id:request,court_ids:courtIds,title:'Local open play',starts_at:at(a),ends_at:at(b),capacity:12,group_limit:4,price_centavos:25000});
  const rpcCreate=command=>service.rpc('owner_session_create',{actor_user_id:users[0],session_input:command});
  const createSql=command=>`select public.owner_session_create('${users[0]}',${literal(command)});`;
  const rentalSql=(a,b)=>`select public.rental_booking_request('${users[1]}','${courts[0]}','${randomUUID()}','${at(a)}','${at(b)}',
    public.rental_booking_quote('${users[1]}','${courts[0]}','${at(a)}','${at(b)}')->'expected_quote');`;
  const heldRace=async(first,second)=>{
    const name=`pickly-session-${randomUUID()}`;
    const holder=dbSession(`set application_name='${name}';begin;${first}select pg_sleep(1.89);commit;`);
    let observed=false;
    for(let n=0;n<100&&!observed;n++){
      observed=sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event='PgSleep'`)==='1';
      if(!observed)await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(observed,'Observed holder locks');const competitor=await dbSession(second);const winner=await holder;assert.equal(winner.code,0,'Holder committed');return competitor;
  };
  try{
    for(let n=0;n<2;n++){
      const credentials={email:`sessions-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own account').user.id);
      const c=createClient(api.href,config.ANON_KEY,options);clients.push(c);tokens.push(check(await c.auth.signInWithPassword(credentials),'Own login').session.access_token);
    }
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Sessions Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);created=true;
    sql(`insert into public.courts(id,venue_id,name) values('${courts[0]}','${venue}','A'),('${courts[1]}','${venue}','B');
      insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',0,'end_minute',1440,'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));`);
    const deps=createSupabaseSessionDeps(()=>anon,()=>createClient(api.href,config.SERVICE_ROLE_KEY,options));
    const handler=createSessionHandler({...deps,limit:async()=>({allowed:true,status:200,state:'enforced',headers:{}})});
    const transports=tokens.map(token=>({endpoint:'https://session.local',apiKey:config.ANON_KEY,accessToken:async()=>token,
      fetch:async(url,init)=>handler(new Request(url,init))}));
    assert.equal((await mobile.listSessions(transports[1],venue)).failure.reason,'not_owner');
    const original=input(600,660);
    const replies=await Promise.all(Array.from({length:6},(_,i)=>rpcCreate({...original,court_ids:i%2?[...courts].reverse():courts})));
    const saved=replies.map(r=>check(r,'Concurrent retry'));assert.equal(new Set(saved.map(r=>r.session.id)).size,1);
    assert.deepEqual(saved.map(r=>r.outcome).sort(),['created',...Array(5).fill('existing')]);
    assert.equal(sql(`select count(*) from private.session_courts where session_id='${saved[0].session.id}'`),'2');
    const changed=await rpcCreate({...original,capacity:10});assert.equal(changed.error?.hint,'request_reused');
    // Opposite client court order shares sorted locks: one session wins, no partial loser.
    const overlaps=await Promise.all(Array.from({length:6},(_,i)=>rpcCreate(input(720,780,i%2?[...courts].reverse():courts))));
    assert.equal(overlaps.filter(r=>!r.error).length,1);assert.ok(overlaps.filter(r=>r.error).every(r=>r.error.hint==='allocation_conflict'));
    assert.equal(sql(`select count(*) from private.court_allocations where venue_id='${venue}' and starts_at='${at(720)}'`),'2');
    // Real rental and multi-court session commands in both lock orders.
    const rentalLoses=await heldRace(createSql(input(840,900)),rentalSql(840,900));assert.notEqual(rentalLoses.code,0);assert.match(rentalLoses.err,/Court already allocated/);
    const sessionLoses=await heldRace(rentalSql(960,1020),createSql(input(960,1020)));assert.notEqual(sessionLoses.code,0);assert.match(sessionLoses.err,/Court already allocated/);
    assert.equal(sql(`select count(*) from private.court_allocations where court_id='${courts[1]}' and starts_at='${at(960)}'`),'0');
    const adjacent=check(await rpcCreate(input(900,960)),'Adjacent half-open session');assert.equal(adjacent.outcome,'created');
    console.log('PASS: real API six retries produce one session/two allocations; six reversed-court overlaps yield one winner; forced session/rental lock orders and adjacency pass.');
    // Lost committed reply: restart journal, edit policy, retry original still returns original snapshot.
    const values=new Map();const store={get:async key=>values.get(key)??null,set:async(key,value)=>values.set(key,value),remove:async key=>values.delete(key)};
    const lost=input(1080,1140);const first=createSessionJournal(store,'local-owner');let lostId;
    await first.run(lost,async command=>{const r=await mobile.createSession(transports[0],command);assert.equal(r.ok,true);lostId=r.value.session.id;return {ok:false,failure:{kind:'network',retryAfterSeconds:null}};});
    check(await service.rpc('owner_venue_policy_save',{actor_user_id:users[0],target_venue_id:venue,expected_revision:'0',policy_input:{confirmation:'approval',payment:'arrival'}}),'Policy edit');
    const recovered=await createSessionJournal(store,'local-owner').run(lost,c=>mobile.createSession(transports[0],c));assert.equal(recovered.ok,true);
    assert.equal(recovered.value.session.id,lostId);assert.equal(recovered.value.session.snapshot.policy.confirmation,'instant');
    const cancels=await Promise.all(Array.from({length:6},()=>service.rpc('owner_session_cancel',{actor_user_id:users[0],target_session_id:lostId})));
    assert.deepEqual(cancels.map(r=>check(r,'Cancel retries').outcome).sort(),['cancelled',...Array(5).fill('existing')]);
    assert.equal(sql(`select count(*) from private.court_allocations where id in (select allocation_id from private.session_courts where session_id='${lostId}') and state='released'`),'2');
    assert.equal((await mobile.createSession(transports[0],lost)).value.session.status,'cancelled');
    const list=await mobile.listSessions(transports[0],venue);assert.equal(list.ok,true);assert.ok(list.value.sessions.some(s=>s.id===lostId&&s.status==='cancelled'));
    for(const c of [anon,clients[0]])assert.equal((await c.rpc('owner_session_create',{actor_user_id:users[0],session_input:input(1200,1260)})).error?.code,'42501');
    // Revocation waiting behind creation, then revocation ahead of creation.
    const revoke=`select id from public.venues where id='${venue}' for update;delete from private.venue_owners where venue_id='${venue}';`;
    assert.equal((await heldRace(createSql(input(1200,1260)),`begin;${revoke}commit;`)).code,0);
    assert.equal((await rpcCreate(input(1260,1320))).error?.hint,'not_owner');
    sql(`insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');`);
    const denied=await heldRace(revoke,createSql(input(1260,1320)));assert.notEqual(denied.code,0);assert.match(denied.err,/Owner required/);
    sql(`insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');`);
    console.log('PASS: actual mobile parser/journal recovers lost committed reply after policy edit; duplicate cancellation releases two courts once; client bypass and both owner-revocation lock orders pass.');
    // Serve the actual pinned Deno Edge runtime, with Redis deliberately absent.
    const envPath=path.join(temp,'functions.env');fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\n`);
    child=spawn(cli,['functions','serve','owner-sessions','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const endpoint=new URL('functions/v1/owner-sessions',api).href;
    const invoke=(token,tail='',init={})=>fetch(endpoint+tail,{...init,headers:{apikey:config.ANON_KEY,...(token?{authorization:`Bearer ${token}`}:{ }),...init.headers},signal:AbortSignal.timeout(20000)});
    let ready=false;for(let n=0;n<90;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');try{if((await invoke(null)).status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}assert.ok(ready,'Edge ready');
    const forged=`${tokens[0].split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[0],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await invoke(forged,`?venue_id=${venue}`)).status,401);
    const before=sql(`select count(*) from private.court_allocations where venue_id='${venue}'`);
    const stopped=await invoke(tokens[0],'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'create',...input(1260,1320)})});
    assert.equal(stopped.status,503);assert.equal(stopped.headers.get('retry-after'),'5');assert.equal(sql(`select count(*) from private.court_allocations where venue_id='${venue}'`),before);
    assert.equal((await invoke(tokens[0],`?venue_id=${venue}`)).status,200);
    const release=await invoke(tokens[0],'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'cancel',session_id:saved[0].session.id})});assert.equal(release.status,200);assert.equal((await release.json()).session.status,'cancelled');
    assert.equal(sql(`select count(*) from private.directory_audit_events where target_venue_id='${venue}' and action='session.cancel'`),'2');
    console.log('PASS: actual served Edge forged JWT401, Redis-outage creation503 with no write, owner history200 and empty-session cancellation200.');
  }finally{
    if(child&&child.exitCode===null)child.kill();for(const worker of workers)worker.kill();let clean=true;const steps=[];
    if(created)steps.push(()=>sql(`delete from public.venues where id='${venue}';`));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own account cleanup'));
    steps.push(()=>sql(`delete from private.directory_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-sessions-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,anon,...clients])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own fixtures/accounts/audits/temp removed; pre-existing IDs preserved; no hosted changes.');
}
main().catch(error=>{console.error(`Local session check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);process.exitCode=1;});
