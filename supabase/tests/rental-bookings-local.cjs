// Local Docker/Auth/PostgREST and served Edge only. Never reads mobile/hosted env.
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
  const sqlArgs=['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'];
  const psql=sql=>run(sqlArgs,sql).trim();
  run([...sqlArgs,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'rental-bookings.sql'),'utf8'));
  console.log('PASS: Docker lifecycle SQL (instant/approval, holds, retries, permissions, freshness, suspension, expiry, pagination, audit rollback); fixtures rolled back.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(result,message)=>{assert.ok(!result.error,message);return result.data;};
  const users=[];const sessions=[];const clients=[];const venue=randomUUID();const courts=[randomUUID(),randomUUID()];
  const prefix=`pickly-booking-${randomUUID().slice(0,8)}`;const workers=new Set();
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-booking-'));let created=false;let child;
  const handlerModule=load(path.join(__dirname,'../functions/rental-bookings/handler.ts'),{},{TextDecoder});
  const {createSupabaseRentalDeps}=load(path.join(__dirname,'../functions/rental-bookings/deps.ts'),{'./handler.ts':handlerModule});
  const deps=createSupabaseRentalDeps(()=>createClient(api.href,config.ANON_KEY,options),()=>createClient(api.href,config.SERVICE_ROLE_KEY,options));
  const handler=handlerModule.createRentalHandler({...deps,limit:async()=>({allowed:true,status:200,state:'enforced',headers:{}})});
  const post=(who,body)=>handler(new Request('https://rental.local',{method:'POST',headers:{authorization:`Bearer ${sessions[who].access_token}`,'content-type':'application/json'},body:JSON.stringify(body)}));
  const get=(who,params)=>handler(new Request('https://rental.local?'+new URLSearchParams(params),{headers:{authorization:`Bearer ${sessions[who].access_token}`}}));
  const day=new Date(Date.now()+8*3600000+2*86400000).toISOString().slice(0,10);
  const at=minute=>new Date(Date.parse(`${day}T00:00:00+08:00`)+minute*60000).toISOString();
  const daily=rate=>({weekly:Array.from({length:7},()=>[{start_minute:0,end_minute:1440,rates:[{start_minute:0,end_minute:1440,hourly_centavos:rate}]}]),exceptions:[]});
  const quote=async(minute,court=courts[0])=>{
    const r=await get(1,{section:'quote',court_id:court,starts_at:at(minute),ends_at:at(minute+60)});assert.equal(r.status,200,'Quote');return (await r.json()).quote;
  };
  const command=(minute,q,request=randomUUID(),court=courts[0])=>({kind:'request',court_id:court,request_id:request,starts_at:at(minute),ends_at:at(minute+60),expected_quote:q.expected_quote});
  const reserve=async(minute,court=courts[0])=>{const r=await post(1,command(minute,await quote(minute,court),randomUUID(),court));assert.equal(r.status,200,'Reserve');return (await r.json()).booking;};
  const change=(who,kind,id)=>post(who,{kind,booking_id:id});
  const query=(sql,label,hold=false)=>{
    const process=spawn(docker,sqlArgs,{windowsHide:true,stdio:['pipe','pipe','pipe']});workers.add(process);let output='';let error='';
    process.stdout.on('data',data=>output+=data);process.stderr.on('data',data=>error+=data);
    const result=new Promise(resolve=>{process.once('error',()=>{workers.delete(process);resolve({code:-1,output,error:'Worker launch failed'});});
      process.once('close',code=>{workers.delete(process);resolve({code,output,error});});});
    const input=`set application_name='${prefix}-${label}'; ${sql}\n`;
    if(hold)process.stdin.write(input);else process.stdin.end(input);result.finish=()=>process.stdin.end('commit;\n');return result;
  };
  const waitFor=async(label,locking=false)=>{
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      if(psql(`select exists(select 1 from pg_stat_activity where application_name='${prefix}-${label}' and ${locking?"wait_event_type='Lock'":"state='idle in transaction'"});`)==='t')return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error('Worker did not reach expected lock state');
  };
  const sqlRequest=(c)=>`select public.rental_booking_request('${users[1]}','${c.court_id}','${c.request_id}','${c.starts_at}','${c.ends_at}','${JSON.stringify(c.expected_quote)}');`;
  try {
    check(await service.from('venues').insert({id:venue,name:'Local Booking Fixture',address_line:'Fixture',city:'Fixture',province:'Fixture',latitude:14.6,longitude:121,publication_status:'approved',claim_status:'verified'}),'Own venue');created=true;
    check(await service.from('courts').insert(courts.map((id,i)=>({id,venue_id:venue,name:`Court ${i}`,status:'active'}))),'Own courts');
    for(let n=0;n<3;n++){
      const credentials={email:`booking-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own user').user.id);
      const client=createClient(api.href,config.ANON_KEY,options);clients.push(client);sessions.push(check(await client.auth.signInWithPassword(credentials),'Own login').session);
    }
    psql(`insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');
      select public.venue_schedule_save('${users[0]}','${venue}',null,'${JSON.stringify(daily(40000))}');`);
    const q=await quote(60);const c=command(60,q);
    const requests=await Promise.all(Array.from({length:6},()=>post(1,c)));
    for(const r of requests)assert.equal(r.status,200);
    const results=await Promise.all(requests.map(r=>r.json()));const original=results[0].booking;
    assert.equal(results.filter(r=>r.outcome==='created').length,1);assert.equal(original.status,'confirmed');
    for(const r of results)assert.deepEqual(r.booking.snapshot,original.snapshot);
    assert.equal(psql(`select count(*) from private.rental_events where booking_id='${original.id}' and action='request'`),'1');
    assert.equal((await post(1,{...c,ends_at:at(150)})).status,409);
    const overlap=await Promise.all([post(1,command(150,await quote(150))),post(2,command(150,await quote(150)))]);
    assert.deepEqual(overlap.map(r=>r.status).sort(),[200,409]);
    assert.equal((await reserve(210)).status,'confirmed','Adjacent rental');
    const crossKey=randomUUID();const cross=await Promise.all([post(1,command(300,await quote(300),crossKey)),post(1,command(300,await quote(300,courts[1]),crossKey,courts[1]))]);
    assert.deepEqual(cross.map(r=>r.status).sort(),[200,409]);
    assert.equal(psql(`select count(*) from private.court_allocations where requested_by='${users[1]}' and request_id='${crossKey}'`),'1');
    assert.equal((await change(2,'cancel',original.id)).status,403);assert.equal((await change(1,'accept',original.id)).status,403);
    assert.equal((await get(2,{section:'booking',booking_id:original.id})).status,403);
    assert.equal((await get(1,{section:'requests',venue_id:venue})).status,403);
    for(const client of [anon,clients[1]]){
      assert.equal((await client.rpc('rental_booking_request',{actor_user_id:users[1],target_court_id:c.court_id,request_id:randomUUID(),starts:c.starts_at,ends:c.ends_at,expected_quote:c.expected_quote})).error?.code,'42501');
      assert.equal((await client.rpc('rental_booking_read',{actor_user_id:users[1]})).error?.code,'42501');
      assert.equal((await client.rpc('rental_booking_change',{actor_user_id:users[0],target_booking_id:original.id,command:'accept'})).error?.code,'42501');
    }
    console.log('PASS: Real Auth/handler/PostgREST instant arrival, six retries one booking/event, overlap one winner, adjacency, cross-court key isolation and direct RPC bypass denial.');

    const policy=(revision,confirmation)=>`select public.owner_venue_policy_save('${users[0]}','${venue}','${revision}','{"confirmation":"${confirmation}","payment":"arrival"}');`;
    psql(policy(0,'approval'));
    const pending=await reserve(390);assert.equal(pending.status,'pending');
    assert.ok(Date.parse(pending.allocation.expires_at)<=Date.now()+2*3600000);
    const race=await Promise.all([change(0,'accept',pending.id),change(1,'cancel',pending.id)]);
    assert.ok(race.every(r=>[200,409].includes(r.status)));
    const final=(await (await get(1,{section:'booking',booking_id:pending.id})).json()).booking;
    assert.equal(final.status,'cancelled');assert.equal(final.allocation.state,'released');assert.deepEqual(final.snapshot,pending.snapshot);
    const decline=await reserve(480);assert.equal((await change(0,'decline',decline.id)).status,200);
    assert.equal((await (await change(0,'decline',decline.id)).json()).outcome,'existing');

    // Waited acceptance observes expiry after taking the court lock, even without cron.
    const expires=await reserve(570);
    let holder=query(`begin; select id from public.courts where id='${courts[0]}' for no key update;
      update private.court_allocations set expires_at=clock_timestamp()+interval '300 milliseconds' where id='${expires.id}';`,'expiry-holder',true);
    await waitFor('expiry-holder');
    const accept=query(`select public.rental_booking_change('${users[0]}','${expires.id}','accept');`,'accept-waits');await waitFor('accept-waits',true);
    psql('select pg_sleep(0.35);');holder.finish();
    const expiredResults=await Promise.all([holder,accept]);assert.ok(expiredResults.every(r=>r.code===0),'Expiry race workers');
    const expired=JSON.parse(expiredResults[1].output.trim()).booking;assert.equal(expired.status,'expired');assert.equal(expired.allocation.state,'expired');
    assert.equal((await reserve(570)).status,'pending','Expired interval immediately reusable');

    // Editor-first: stale reviews waiting on the venue lock create no inventory.
    const stale=command(660,await quote(660));holder=query(`begin; ${policy(1,'instant')}`,'policy-first',true);await waitFor('policy-first');
    let waiter=query(sqlRequest(stale),'request-waits');await waitFor('request-waits',true);holder.finish();
    let pair=await Promise.all([holder,waiter]);assert.equal(pair[0].code,0);assert.notEqual(pair[1].code,0);assert.match(pair[1].error,/Review changed price/);
    assert.equal(psql(`select count(*) from private.court_allocations where request_id='${stale.request_id}'`),'0');
    const staleRate=command(750,await quote(750));holder=query(`begin; select public.venue_schedule_save('${users[0]}','${venue}','1','${JSON.stringify(daily(50000))}');`,'schedule-first',true);await waitFor('schedule-first');
    waiter=query(sqlRequest(staleRate),'rate-request-waits');await waitFor('rate-request-waits',true);holder.finish();
    pair=await Promise.all([holder,waiter]);assert.equal(pair[0].code,0);assert.notEqual(pair[1].code,0);assert.match(pair[1].error,/Review changed price/);
    assert.equal((await reserve(750)).snapshot.total_centavos,50000);
    assert.deepEqual((await (await post(1,c)).json()).booking.snapshot,original.snapshot,'Retry uses original review/snapshot');
    console.log('PASS: Approval/decline, accept-cancel race, waited expiry without revival, rate/policy-first stale review refusal and immutable retry snapshots.');

    psql(policy(2,'approval'));const revoked=await reserve(840);
    psql(`delete from private.venue_owners where venue_id='${venue}'; insert into private.account_roles(user_id,role) values('${users[0]}','admin');`);
    assert.equal((await change(0,'accept',revoked.id)).status,403,'Admin role cannot replace venue ownership');
    assert.equal((await get(0,{section:'requests',venue_id:venue})).status,403);
    psql(`insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}'); update public.venues set publication_status='suspended' where id='${venue}';`);
    assert.equal((await change(0,'accept',revoked.id)).status,404);
    assert.equal((await get(1,{section:'quote',court_id:courts[0],starts_at:at(930),ends_at:at(990)})).status,404);
    assert.equal((await change(1,'cancel',revoked.id)).status,200);
    psql(`update public.venues set publication_status='approved' where id='${venue}';`);
    // T25: exercise the actual mobile parser/journal against verified Auth + real PostgreSQL.
    const mobile=require('../../src/features/rental/__tests__/helpers.cjs');
    const store=mobile.memory();let loseMobileReply=true;
    const mobileTransport={endpoint:'https://rental.local',apiKey:config.ANON_KEY,accessToken:async()=>sessions[1].access_token,
      fetch:async(url,init)=>{
        const response=await handler(new Request(url,init));
        if(init.method==='POST'&&JSON.parse(init.body).kind==='request'&&loseMobileReply){loseMobileReply=false;throw new Error('Lost reply after commit');}
        return {ok:response.ok,status:response.status,headers:response.headers,json:()=>response.json()};
      }};
    const mobileWindow={court_id:courts[0],starts_at:at(1080),ends_at:at(1170)};
    const mobileQuote=await mobile.client.loadQuote(mobileTransport,mobileWindow);assert.equal(mobileQuote.ok,true,'Mobile quote parser');
    const mobileCommand=mobile.model.reviewedRequest(mobileQuote.value,randomUUID());
    const journal=mobile.createAttemptJournal(store,'local.player');
    assert.equal((await journal.run(mobileCommand,c=>mobile.client.requestRental(mobileTransport,c))).failure.kind,'network');
    const restoredJournal=mobile.createAttemptJournal(store,'local.player');
    const recovered=await restoredJournal.run(await restoredJournal.read(),c=>mobile.client.requestRental(mobileTransport,c));
    assert.equal(recovered.ok,true,'Mobile recovered reply');assert.equal(recovered.value.outcome,'existing');assert.equal(recovered.value.booking.status,'pending');
    assert.equal(psql(`select count(*) from private.court_allocations where requested_by='${users[1]}' and request_id='${mobileCommand.request_id}'`),'1');
    assert.equal(await restoredJournal.read(),null);
    const mobileCancel=await mobile.client.cancelRental(mobileTransport,recovered.value.booking.id);assert.equal(mobileCancel.ok,true);assert.equal(mobileCancel.value.booking.status,'cancelled');
    assert.deepEqual(mobile.plain(mobileCancel.value.booking.snapshot),mobile.plain(recovered.value.booking.snapshot));
    const mobileHistory=await mobile.client.loadHistory(mobileTransport,null);assert.equal(mobileHistory.ok,true,'Mobile history parser');
    assert.ok(mobileHistory.value.bookings.some(b=>b.status==='expired'));assert.ok(mobileHistory.value.bookings.some(b=>b.id===recovered.value.booking.id));
    console.log('PASS: T25 actual mobile quote/history/status parsers, durable lost-reply recovery with one allocation, unpaid approval and cancellation with unchanged snapshot.');
    const servedCancel=await reserve(930);const countBefore=psql(`select count(*) from private.court_allocations where venue_id='${venue}'`);
    console.log('PASS: Owner revocation/admin-role isolation, suspended request/accept refusal and suspended player cancellation.');

    // Real Edge guard: absent Redis must reject new holds, while release/read continue.
    const envPath=path.join(temp,'functions.env');
    fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\n`);
    child=spawn(cli,['functions','serve','rental-bookings','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>launchError=true);
    const endpoint=new URL('functions/v1/rental-bookings',api).href;
    const invoke=(token,tail='',init={})=>fetch(endpoint+tail,{...init,headers:{apikey:config.ANON_KEY,...(token?{authorization:`Bearer ${token}`}:{ }),...init.headers},signal:AbortSignal.timeout(8000)});
    let ready=false;for(let n=0;n<90;n++){
      assert.ok(!launchError&&child.exitCode===null,'Own Edge server running');
      try{if((await invoke(null)).status===401){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.ok(ready,'Local Edge ready');
    const token=sessions[1].access_token;
    const forged=`${token.split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[1],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await invoke(forged,'?section=history')).status,401);
    assert.equal((await invoke(token,'?section=history')).status,200);
    const refused=await invoke(token,'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command(1020,await quote(1020)))});
    assert.equal(refused.status,503);assert.equal(refused.headers.get('retry-after'),'5');
    assert.equal(psql(`select count(*) from private.court_allocations where venue_id='${venue}'`),countBefore);
    const cancelled=await invoke(token,'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'cancel',booking_id:servedCancel.id})});
    assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).booking.status,'cancelled');
    console.log('PASS: Served Edge forged-JWT 401, bounded history 200, Redis-outage hold 503 with unchanged inventory, cancellation 200.');
  } finally {
    if(child&&child.exitCode===null)child.kill();
    if(workers.size){psql(`select pg_terminate_backend(pid) from pg_stat_activity where application_name like '${prefix}-%';`);await new Promise(resolve=>setTimeout(resolve,100));}
    let clean=true;const steps=[];
    if(created)steps.push(async()=>check(await service.from('venues').delete().eq('id',venue),'Own venue cleanup'));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own user cleanup'));
    steps.push(()=>psql(`delete from private.directory_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-booking-/);
      const envPath=path.join(temp,'functions.env');if(fs.existsSync(envPath))fs.unlinkSync(envPath);fs.rmdirSync(temp);});
    for(const client of [service,anon,...clients])steps.push(()=>client.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}
    assert.ok(clean,'Own fixtures/temp removed');
    assert.equal(psql(`select (select count(*) from private.court_allocations where venue_id='${venue}')+
      (select count(*) from private.directory_audit_events where target_venue_id='${venue}')+
      (select count(*) from auth.users where id in (${users.map(id=>`'${id}'`).join(',')||'null'}))`),'0');
  }
  console.log('PASS: Own local fixtures/accounts/events/env removed; own server stopped; no hosted changes.');
}
main().catch(error=>{console.error(`Local rental booking check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);process.exitCode=1;});
