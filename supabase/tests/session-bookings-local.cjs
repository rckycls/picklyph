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
    'sessions',(select jsonb_agg(id order by id) from private.open_play_sessions),'bookings',(select jsonb_agg(id order by id) from private.session_bookings),
    'events',(select jsonb_agg(id order by id) from private.session_booking_events),'audit',(select jsonb_agg(id order by id) from private.directory_audit_events));`);
  const beforeInventory=inventory();
  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'session-bookings.sql'),'utf8'));
  console.log('PASS: Docker group-booking SQL permissions, names/limits, capacity, holds/expiry, retries, access, suspension and event rollback.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(r,message)=>{assert.ok(!r.error,message);return r.data;};const users=[],clients=[],tokens=[];const venue=randomUUID();const courts=[randomUUID(),randomUUID()].sort();
  let created=false;let child;const workers=new Set();const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-groups-'));
  const dbSession=query=>new Promise(resolve=>{
    const worker=spawn(docker,args,{windowsHide:true});workers.add(worker);let out='',err='';
    worker.stdout.on('data',d=>out+=d);worker.stderr.on('data',d=>err+=d);
    worker.on('error',()=>resolve({code:-1,out,err}));worker.on('close',code=>{workers.delete(worker);resolve({code,out:out.trim(),err});});worker.stdin.end(query);
  });
  const heldRace=async(first,second)=>{
    const name=`pickly-groups-${randomUUID()}`;
    const holder=dbSession(`set application_name='${name}';begin;${first}select pg_sleep(1.89);commit;`);
    let observed=false;
    for(let n=0;n<100&&!observed;n++){
      observed=sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event='PgSleep'`)==='1';
      if(!observed)await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(observed,'Observed holder locks');const competitor=await dbSession(second);const winner=await holder;assert.equal(winner.code,0,'Holder committed');return competitor;
  };
  const handlerModule=load(path.join(__dirname,'../functions/session-bookings/handler.ts'),{},{TextDecoder});
  const {createSupabaseSessionBookingDeps}=load(path.join(__dirname,'../functions/session-bookings/deps.ts'),{'./handler.ts':handlerModule});
  const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();
  const createSession=async(a,b,capacity,lim,court=courts[0])=>check(await service.rpc('owner_session_create',{actor_user_id:users[0],session_input:{venue_id:venue,
    request_id:randomUUID(),court_ids:[court],title:'Local group play',starts_at:at(a),ends_at:at(b),capacity,group_limit:lim,price_centavos:25000}}),'Own session').session.id;
  const policy=confirmation=>sql(`select public.owner_venue_policy_save('${users[0]}','${venue}',(select private.venue_policy_view('${venue}')->>'revision'),
    '{"confirmation":"${confirmation}","payment":"arrival"}');`);
  const names=n=>Array.from({length:n},(_,i)=>`Player ${i+1}`);
  const body=(session,n,request=randomUUID())=>({kind:'request',session_id:session,request_id:request,participants:names(n),expected_total_centavos:25000*n});
  const reqSql=(player,b)=>`select public.session_booking_request('${users[player]}',${literal({session_id:b.session_id,request_id:b.request_id,participants:b.participants,expected_total_centavos:b.expected_total_centavos})});`;
  const changeSql=(actor,booking,command)=>`select public.session_booking_change('${users[actor]}','${booking}','${command}');`;
  const reserved=session=>Number(sql(`select reserved_spots from private.open_play_sessions where id='${session}'`));
  const invariant=()=>assert.equal(sql(`select count(*) from private.open_play_sessions s where s.venue_id='${venue}' and s.reserved_spots<>coalesce((select sum(b.spots)
    from private.session_bookings b where b.session_id=s.id and b.status in ('pending','confirmed')),0)`),'0','Counter equals live spots');
  const events=booking=>JSON.parse(sql(`select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from private.session_booking_events
    where booking_id='${booking}' group by action) x;`));
  const elapse=booking=>sql(`begin;alter table private.session_bookings disable trigger session_booking_guard;
    update private.session_bookings set expires_at=clock_timestamp()-interval '1 second' where id='${booking}';
    alter table private.session_bookings enable trigger session_booking_guard;commit;`);
  try{
    for(let n=0;n<7;n++){
      const credentials={email:`groups-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own account').user.id);
      const c=createClient(api.href,config.ANON_KEY,options);clients.push(c);tokens.push(check(await c.auth.signInWithPassword(credentials),'Own login').session.access_token);
    }
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Groups Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);created=true;
    sql(`insert into public.courts(id,venue_id,name) values('${courts[0]}','${venue}','A'),('${courts[1]}','${venue}','B');
      insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',0,'end_minute',1440,'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));`);
    const deps=createSupabaseSessionBookingDeps(()=>anon,()=>createClient(api.href,config.SERVICE_ROLE_KEY,options));
    const handler=handlerModule.createSessionBookingHandler({...deps,limit:async()=>({allowed:true,status:200,state:'enforced',headers:{}})});
    const post=(player,command)=>handler(new Request('https://groups.local',{method:'POST',headers:{authorization:`Bearer ${tokens[player]}`,'content-type':'application/json'},body:JSON.stringify(command)}));
    const get=(player,tail)=>handler(new Request(`https://groups.local?${tail}`,{headers:{authorization:`Bearer ${tokens[player]}`}}));
    // Six players race three-person groups for eight spots: exactly two groups fit and the counter never oversells.
    const open=await createSession(600,720,8,4);
    const racing=await Promise.all([1,2,3,4,5,6].map(p=>post(p,body(open,3))));
    assert.deepEqual(racing.map(r=>r.status).sort(),[200,200,409,409,409,409]);
    const refusals=await Promise.all(racing.filter(r=>r.status===409).map(r=>r.json()));assert.ok(refusals.every(r=>r.error==='session_full'));
    assert.equal(reserved(open),6);invariant();
    const offer=await (await get(6,`section=session&session_id=${open}`)).json();assert.equal(offer.session.available_spots,2);assert.ok(!JSON.stringify(offer).includes('Player 1'));
    // Six retries of one key create one group/event; the same player's second key is refused.
    const retried=await createSession(780,840,8,4);const original=body(retried,2);
    const retries=await Promise.all(Array.from({length:6},()=>post(1,original)));assert.ok(retries.every(r=>r.status===200));
    const replies=await Promise.all(retries.map(r=>r.json()));assert.deepEqual(replies.map(r=>r.outcome).sort(),['created',...Array(5).fill('existing')]);
    assert.equal(new Set(replies.map(r=>r.booking.id)).size,1);assert.deepEqual(events(replies[0].booking.id),{request:1});
    const twoKeys=await Promise.all([post(2,body(retried,1)),post(2,body(retried,1))]);
    assert.deepEqual(twoKeys.map(r=>r.status).sort(),[200,409]);assert.equal((await twoKeys.find(r=>r.status===409).json()).error,'already_booked');
    assert.equal((await post(1,{...original,participants:['Someone else','Player 2']})).status,409);
    assert.equal(reserved(retried),3);invariant();
    console.log('PASS: real API six concurrent three-person groups fill eight spots with two winners; six retries record one group/event; one live group per player.');
    // Forced lock orders: filling vs a later group, release vs a waiting group, and T27 empty-session cancellation.
    const small=await createSession(900,960,4,4);const fill=body(small,4);
    let competitor=await heldRace(reqSql(1,fill),reqSql(2,body(small,1)));assert.notEqual(competitor.code,0);assert.match(competitor.err,/Session full/);
    const filled=JSON.parse(sql(`select public.session_booking_read('${users[1]}','history')`)).bookings.find(b=>b.session_id===small);
    competitor=await heldRace(changeSql(1,filled.id,'cancel'),reqSql(2,body(small,1)));assert.equal(competitor.code,0);assert.equal(JSON.parse(competitor.out).outcome,'created');
    assert.equal(reserved(small),1);
    const cancelFirst=await createSession(1020,1080,4,4);
    competitor=await heldRace(`select public.owner_session_cancel('${users[0]}','${cancelFirst}');`,reqSql(3,body(cancelFirst,1)));
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Session cancelled/);
    const bookFirst=await createSession(1140,1200,4,4);
    competitor=await heldRace(reqSql(3,body(bookFirst,1)),`select public.owner_session_cancel('${users[0]}','${bookFirst}');`);
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Session has bookings/);invariant();
    console.log('PASS: observed lock waits serialize filling/later groups and release/rebook in both orders; T27 cancellation and group requests never both succeed.');
    // Approval holds: accept/cancel and revocation/accept in both lock orders; elapsed holds resell without cron.
    policy('approval');const approval=await createSession(1260,1320,4,4,courts[1]);
    const pending=async(player,n)=>{const r=await post(player,body(approval,n));assert.equal(r.status,200);const b=(await r.json()).booking;assert.equal(b.status,'pending');return b;};
    let held=await pending(4,1);
    competitor=await heldRace(changeSql(0,held.id,'accept'),changeSql(4,held.id,'cancel'));assert.equal(competitor.code,0);
    assert.deepEqual(events(held.id),{request:1,accept:1,cancel:1});
    held=await pending(5,1);
    competitor=await heldRace(changeSql(5,held.id,'cancel'),changeSql(0,held.id,'accept'));assert.notEqual(competitor.code,0);assert.match(competitor.err,/cannot change/);
    assert.deepEqual(events(held.id),{request:1,cancel:1});assert.equal(reserved(approval),0);
    const revoke=`select id from public.venues where id='${venue}' for update;delete from private.venue_owners where venue_id='${venue}';`;
    held=await pending(6,1);
    competitor=await heldRace(revoke,changeSql(0,held.id,'accept'));assert.notEqual(competitor.code,0);assert.match(competitor.err,/Owner required/);
    sql(`insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');`);
    assert.equal((await heldRace(changeSql(0,held.id,'accept'),`begin;${revoke}commit;`)).code,0);
    assert.equal((await get(0,`section=booking&booking_id=${held.id}`)).status,403);assert.equal((await post(6,{kind:'cancel',booking_id:held.id})).status,200);
    sql(`insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');`);
    const staleBody=body(approval,4);const staleReply=await post(1,staleBody);assert.equal(staleReply.status,200);
    const stale=(await staleReply.json()).booking;assert.equal(stale.status,'pending');elapse(stale.id);
    assert.equal((await (await get(1,`section=booking&booking_id=${stale.id}`)).json()).booking.status,'expired');
    const resale=await Promise.all([2,3,4,5,6].map(p=>post(p,body(approval,2))));
    assert.deepEqual(resale.map(r=>r.status).sort(),[200,200,409,409,409]);
    assert.deepEqual(events(stale.id),{request:1,expire:1});assert.equal(reserved(approval),4);
    const lateAccept=await post(0,{kind:'accept',booking_id:stale.id});assert.equal(lateAccept.status,409);assert.equal((await lateAccept.json()).error,'invalid_transition');
    const revived=await (await post(1,staleBody)).json();assert.equal(revived.outcome,'existing');assert.equal(revived.booking.status,'expired');
    assert.equal((await (await post(1,{...staleBody,participants:names(3),expected_total_centavos:75000})).json()).error,'request_reused');
    assert.deepEqual(events(stale.id),{request:1,expire:1});invariant();
    const requests=await (await get(0,`section=requests&venue_id=${venue}`)).json();assert.equal(requests.bookings.length,2);
    assert.ok(requests.bookings.every(b=>b.status==='pending'&&b.participants.length===2));
    console.log('PASS: accept/cancel and revocation/accept in both lock orders; elapsed four-spot hold reads expired, resells to exactly two groups and records one expiry.');
    for(const c of [anon,clients[1]])assert.equal((await c.rpc('session_booking_request',{actor_user_id:users[1],booking_input:original})).error?.code,'42501');
    // Serve the actual pinned Deno Edge runtime, with Redis deliberately absent.
    const envPath=path.join(temp,'functions.env');fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\n`);
    // A killed Windows `functions serve` leaves its container running; until serve replaces it, Kong
    // reaches that stopping container, which then drops requests mid-check. Wait for a fresh one.
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    child=spawn(cli,['functions','serve','session-bookings','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const endpoint=new URL('functions/v1/session-bookings',api).href;
    const invoke=(token,tail='',init={})=>fetch(endpoint+tail,{...init,headers:{apikey:config.ANON_KEY,...(token?{authorization:`Bearer ${token}`}:{}),...init.headers},signal:AbortSignal.timeout(20000)});
    let ready=false;for(let n=0;n<120;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{const current=edgeId();if(current&&current!==staleEdge&&(await invoke(null)).status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
    assert.ok(ready,'Fresh Edge ready');
    const forged=`${tokens[1].split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[1],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await invoke(forged,'?section=history')).status,401);
    const before=sql(`select count(*) from private.session_bookings`);
    const stopped=await invoke(tokens[6],'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body(open,1))});
    assert.equal(stopped.status,503);assert.equal(stopped.headers.get('retry-after'),'5');assert.equal(sql(`select count(*) from private.session_bookings`),before);
    const live=requests.bookings[0];
    assert.equal((await invoke(tokens[0],'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'accept',booking_id:live.id})})).status,503);
    assert.equal((await invoke(tokens[1],'?section=history')).status,200);
    const declined=await invoke(tokens[0],'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'decline',booking_id:live.id})});
    assert.equal(declined.status,200);assert.equal((await declined.json()).booking.status,'declined');
    const mine=replies[0].booking.id;const released=await Promise.all(Array.from({length:4},()=>invoke(tokens[1],'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'cancel',booking_id:mine})})));
    assert.ok(released.every(r=>r.status===200));assert.deepEqual(events(mine),{request:1,cancel:1});assert.equal(reserved(retried),1);invariant();
    console.log('PASS: actual served Edge forged JWT401, Redis-outage request/accept503 with no write, history200, decline200 and four cancellation retries releasing once.');
  }finally{
    if(child&&child.exitCode===null)child.kill();for(const worker of workers)worker.kill();let clean=true;const steps=[];
    if(created)steps.push(()=>sql(`delete from public.venues where id='${venue}';`));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own account cleanup'));
    steps.push(()=>sql(`delete from private.directory_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-groups-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,anon,...clients])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own fixtures/accounts/audits/temp removed; pre-existing IDs preserved; no hosted changes.');
}
main().catch(error=>{console.error(`Local group booking check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);process.exitCode=1;});
