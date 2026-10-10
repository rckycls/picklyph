// T43: real local Docker/Auth/PostgREST, the shipped push-devices handler and mobile client, the push-dispatch worker against a
// fake Expo server (never the real one), concurrent workers, retries, invalid tokens, leases, receipts and served Edge. No hosted/mobile env.
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');
const {randomUUID,randomBytes}=require('node:crypto');const {execFileSync,spawn}=require('node:child_process');const {createClient}=require('@supabase/supabase-js');
const load=require('./load-ts.cjs');
async function main(){
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
  const context=run(['context','show']).trim();const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const args=['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'];
  const sql=query=>run(args,query).trim();
  const cronInstalled=()=>sql(`select exists(select 1 from pg_extension where extname='pg_cron')`)==='t';
  const cronJobs=()=>cronInstalled()?sql(`select coalesce(jsonb_agg(jsonb_build_array(jobid,jobname,schedule,command,active) order by jobid),'[]') from cron.job`):'none';
  const inventory=()=>sql(`select jsonb_build_object('users',(select jsonb_agg(id order by id) from auth.users),'venues',(select jsonb_agg(id order by id) from public.venues),
    'devices',(select jsonb_agg(id order by id) from private.push_devices),'outbox',(select jsonb_agg(id order by id) from private.notification_outbox),
    'deliveries',(select count(*) from private.push_deliveries),'allocations',(select jsonb_agg(id order by id) from private.court_allocations),
    'vault',(select jsonb_agg(name order by name) from vault.secrets),'extensions',(select jsonb_agg(extname order by extname) from pg_extension));`)+cronJobs();
  const beforeInventory=inventory();
  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'notifications.sql'),'utf8'));
  console.log('PASS: Docker notifications SQL: registration rules, event fan-out, actor exclusion, rollback, claim/complete/lease/retry/receipt rules, cascades.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(r,message)=>{assert.ok(!r.error,`${message}: ${r.error?.message??''}`);return r.data;};const users=[],clients=[],tokens=[];const venue=randomUUID();
  const courts=[randomUUID(),randomUUID()].sort();let created=false;let child;let cronCreated=false;let fake;const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-push-'));
  const root=path.resolve(__dirname,'../..');
  const devicesModule=load(path.join(root,'supabase/functions/push-devices/handler.ts'),{},{TextDecoder});
  const {createSupabasePushDeviceDeps}=load(path.join(root,'supabase/functions/push-devices/deps.ts'),{'./handler.ts':devicesModule},{TextDecoder});
  const expoModule=load(path.join(root,'supabase/functions/push-dispatch/expo.ts'),{},{TextDecoder});
  const dispatchModule=load(path.join(root,'supabase/functions/push-dispatch/handler.ts'),{'./expo.ts':expoModule},{TextDecoder,Intl});
  const {createSupabasePushDispatchDeps}=load(path.join(root,'supabase/functions/push-dispatch/deps.ts'),{},{TextDecoder});
  const {createRateGuard}=load(path.join(root,'supabase/functions/_shared/rate-limit.ts'));
  const mobile=load(path.join(root,'src/features/notifications/pushClient.ts'),{'@picklyph/domain':require(path.join(root,'packages/domain/src/notification.ts')),
    '../owner/venueClient':require(path.join(root,'src/features/owner/venueClient.ts'))});
  const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();
  const pushToken=name=>`ExponentPushToken[local-${name}]`;
  const rent=(user,court,a,b)=>JSON.parse(sql(`select public.rental_booking_request('${users[user]}','${court}','${randomUUID()}','${at(a)}','${at(b)}',
    public.rental_booking_quote('${users[user]}','${court}','${at(a)}','${at(b)}')->'expected_quote')::text;`)).booking.id;
  const change=(user,booking,command)=>sql(`select public.rental_booking_change('${users[user]}','${booking}','${command}')->'booking'->>'status';`);
  const outbox=where=>JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'kind',o.kind,'to',o.recipient_user_id,'status',o.status,'attempts',o.attempts,
    'error',o.last_error) order by o.created_at,o.id),'[]') from private.notification_outbox o where o.payload->>'venue_id'='${venue}' ${where??''};`));
  const devices=user=>sql(`select coalesce(string_agg(replace(replace(token,'ExponentPushToken[local-',''),']','')||case when disabled_at is null then '' else '!' end,',' order by token),'')
    from private.push_devices where user_id='${users[user]}'`);
  // Fake Expo push service on loopback: records every message and replays the scripted mode.
  const expoLog={sent:[],receiptRequests:[]};let expoMode='ok';let ticketNo=0;const ticketToken=new Map();let receiptPlan=()=>({status:'ok'});
  fake=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',async()=>{
    const reply=(status,json,headers={})=>{res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(json));};
    if(req.url==='/--/api/v2/push/send'){
      const messages=JSON.parse(body);await new Promise(r=>setTimeout(r,150));
      if(expoMode==='down')return reply(503,{errors:[{code:'INTERNAL_SERVER_ERROR'}]},{'retry-after':'45'});
      expoLog.sent.push(...messages);
      return reply(200,{data:messages.map(m=>{if(expoMode==='unregister-a2'&&m.to===pushToken('a2'))return {status:'error',message:'not registered',details:{error:'DeviceNotRegistered'}};
        const id=`T-${++ticketNo}`;ticketToken.set(id,m.to);return {status:'ok',id};})});
    }
    if(req.url==='/--/api/v2/push/getReceipts'){const {ids}=JSON.parse(body);expoLog.receiptRequests.push(ids);
      return reply(200,{data:Object.fromEntries(ids.map(id=>[id,receiptPlan(id)]))});}
    reply(404,{});
  });});
  await new Promise(r=>fake.listen(0,'127.0.0.1',r));const fakeBase=`http://127.0.0.1:${fake.address().port}`;
  const expo=expoModule.createExpoPush((url,init)=>fetch(String(url).replace('https://exp.host',fakeBase),{...init,signal:AbortSignal.timeout(10000)}));
  const secret=randomBytes(32).toString('base64url');
  const server=()=>createClient(api.href,config.SERVICE_ROLE_KEY,options);
  const worker=dispatchModule.createPushDispatchHandler({secret,...createSupabasePushDispatchDeps(server),send:expo.send,receipts:expo.receipts});
  const dispatch=async()=>{const r=await worker(new Request('https://local.test',{method:'POST',headers:{authorization:`Bearer ${secret}`}}));assert.equal(r.status,200,'worker run');return r.json();};
  const enforced=async()=>({allowed:true,status:200,state:'enforced',headers:{}});
  const devicesHandler=devicesModule.createPushDevicesHandler({...createSupabasePushDeviceDeps(()=>anon,server),limit:enforced});
  const transport=user=>({endpoint:'https://local.test',apiKey:config.ANON_KEY,accessToken:async()=>tokens[user],
    fetch:async(url,init)=>{const r=await devicesHandler(new Request(url,init));return {ok:r.ok,status:r.status,headers:r.headers,json:()=>r.json()};}});
  try{
    // Accounts: 0 owner, 1 co-owner, 2 player A (two phones), 3 and 4 registration racers, 5 served-Edge player.
    for(let n=0;n<6;n++){
      const credentials={email:`push-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own account').user.id);
      const c=createClient(api.href,config.ANON_KEY,options);clients.push(c);tokens.push(check(await c.auth.signInWithPassword(credentials),'Own login').session.access_token);
    }
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Push Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);created=true;
    sql(`insert into public.courts(id,venue_id,name) values('${courts[0]}','${venue}','A'),('${courts[1]}','${venue}','B');
      insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}'),('${users[1]}','${venue}');
      insert into private.venue_policies(venue_id,confirmation,payment) values('${venue}','approval','arrival');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',0,'end_minute',1440,'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));`);

    // Registration through the shipped mobile client and handler, verified by real GoTrue.
    for(const [user,name] of [[0,'owner'],[1,'coowner'],[2,'a1'],[2,'a2']])assert.equal((await mobile.registerPushDevice(transport(user),pushToken(name),'ios')).ok,true);
    assert.equal(devices(0),'owner');assert.equal(devices(2),'a1,a2');
    const forged=`${tokens[2].split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[2],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    const forgedReply=await devicesHandler(new Request('https://local.test',{method:'POST',headers:{authorization:`Bearer ${forged}`,'content-type':'application/json'},
      body:JSON.stringify({kind:'register',token:pushToken('forged'),platform:'ios'})}));assert.equal(forgedReply.status,401);
    // Direct API access is denied: the RPC is service-only and the tables are private.
    const direct=await clients[2].rpc('push_device_register',{actor_user_id:users[3],device_input:{token:pushToken('direct'),platform:'ios'}});
    assert.equal(direct.error?.code,'42501');assert.equal(sql(`select count(*) from private.push_devices where token in ('${pushToken('forged')}','${pushToken('direct')}')`),'0');
    // Races: two accounts register one token six times each at once → one row; twelve tokens at once for one account → the ten-device cap holds.
    const race=await Promise.all(Array.from({length:12},(_,n)=>mobile.registerPushDevice(transport(3+(n%2)),pushToken('shared'),'ios')));
    assert.ok(race.every(r=>r.ok),'every racing registration answered');
    assert.equal(sql(`select count(*) from private.push_devices where token='${pushToken('shared')}'`),'1');
    const capped=await Promise.all(Array.from({length:12},(_,n)=>mobile.registerPushDevice(transport(4),pushToken(`cap${n}`),'ios')));
    assert.ok(capped.every(r=>r.ok));assert.equal(sql(`select count(*) from private.push_devices where user_id='${users[4]}'`),'10');
    // The rate guard's Redis outage does not stop registration.
    const outageHandler=devicesModule.createPushDevicesHandler({...createSupabasePushDeviceDeps(()=>anon,server),
      limit:createRateGuard({backend:async()=>{throw new Error('Redis down');},identifier:async p=>p.id,timeoutMs:50})});
    const outage=await outageHandler(new Request('https://local.test',{method:'POST',headers:{authorization:`Bearer ${tokens[3]}`,'content-type':'application/json'},
      body:JSON.stringify({kind:'register',token:pushToken('outage'),platform:'ios'})}));assert.equal(outage.status,200);
    console.log('PASS: shipped client + real GoTrue registration; forged JWT 401; direct RPC 42501; 12 racing registrations of one token by two accounts → 1 row; 12 concurrent tokens → 10-device cap; Redis outage → 200.');

    // Booking events through the real commands: 12 pending requests (2 owners each), 6 accepted (player A has two phones).
    const bookings=[];for(let n=0;n<12;n++)bookings.push(rent(2,courts[n%2],480+60*Math.floor(n/2),540+60*Math.floor(n/2)));
    for(const id of bookings.slice(0,6))assert.equal(change(0,id,'accept'),'confirmed');
    const rows=outbox();assert.equal(rows.length,30);
    assert.equal(rows.filter(r=>r.kind==='booking.requested').length,24);assert.equal(rows.filter(r=>r.kind==='booking.accepted'&&r.to===users[2]).length,6);
    assert.ok(!rows.some(r=>r.to===users[2]&&r.kind==='booking.requested'),'the requesting player is never notified of their own request');
    // Two workers at once: SKIP LOCKED leases give each row to one run; every row and device is sent exactly once.
    const [w1,w2]=await Promise.all([dispatch(),dispatch()]);
    assert.equal(w1.claimed+w2.claimed,30,`claims ${w1.claimed}+${w2.claimed}`);assert.ok(w1.claimed>0&&w2.claimed>0,'both workers took rows');
    const pairs=expoLog.sent.map(m=>`${m.data.notification_id}|${m.to}`);assert.equal(pairs.length,36);assert.equal(new Set(pairs).size,36,'no duplicate sends');
    assert.ok(outbox().every(r=>r.status==='sent'));
    const accepted=expoLog.sent.find(m=>m.data.kind==='booking.accepted');
    assert.equal(accepted.title,'Booking confirmed');assert.match(accepted.body,/^Local Push Fixture confirmed your court rental for /);
    assert.deepEqual(Object.keys(accepted.data).sort(),['audience','booking_id','booking_kind','kind','notification_id']);
    assert.equal(accepted.data.audience,'player');assert.ok(bookings.slice(0,6).includes(accepted.data.booking_id));
    console.log('PASS: 12 real requests + 6 acceptances → 30 rows (24 owner, 6 player, none to the requester); two concurrent workers claimed 30 disjoint rows and sent 36 messages, each (row, device) once.');

    // Expo outage: rows back off (Retry-After 45 s) without tickets; when due again, DeviceNotRegistered disables phone a2, a1 still gets it.
    assert.equal(change(0,bookings[6],'decline'),'declined');assert.equal(change(2,bookings[0],'cancel'),'cancelled');
    expoMode='down';const down=await dispatch();assert.equal(down.claimed,3);assert.equal(down.retried,4);
    const waiting=outbox(`and o.status='pending'`);assert.equal(waiting.length,3);assert.ok(waiting.every(r=>r.attempts===1));
    assert.ok(sql(`select bool_and(next_attempt_at>=clock_timestamp()+interval '40 seconds') from private.notification_outbox where payload->>'venue_id'='${venue}' and status='pending'`)==='t','Retry-After honoured');
    assert.equal((await dispatch()).claimed,0,'not due yet');
    sql(`update private.notification_outbox set next_attempt_at=clock_timestamp()-interval '1 second' where payload->>'venue_id'='${venue}' and status='pending';`);
    expoMode='unregister-a2';const before=expoLog.sent.length;const recovered=await dispatch();
    assert.equal(recovered.claimed,3);assert.equal(recovered.invalid,1);assert.equal(devices(2),'a1,a2!');
    assert.ok(outbox().every(r=>r.status==='sent'),'every row sent after the outage');assert.equal(expoLog.sent.length-before,4,'both owners, a1 and a2 once each (a2 answered DeviceNotRegistered)');
    assert.equal(sql(`select count(*) from private.push_deliveries p join private.push_devices d on d.id=p.device_id where d.token='${pushToken('a2')}'
      and p.outbox_id in (select id from private.notification_outbox where payload->>'venue_id'='${venue}' and attempts=2)`),'0','no ticket recorded for a2');
    console.log('PASS: Expo 503 → 3 rows pending (attempt 1, Retry-After 45 s, nothing sent); when due, DeviceNotRegistered disabled a2 while a1 and both owners got it once.');

    // A worker that claimed and died: its lease expires, the next run resends with a new claim, and the dead worker's late reply changes nothing.
    expoMode='ok';assert.equal(change(0,bookings[7],'accept'),'confirmed');
    const dead=check(await service.rpc('push_outbox_claim',{batch_limit:5,lease_seconds:30}),'dead claim');assert.equal(dead.items.length,1);
    assert.equal((await dispatch()).claimed,0,'leased row not taken');
    sql(`update private.notification_outbox set locked_until=clock_timestamp()-interval '1 second' where id='${dead.items[0].id}';`);
    const reclaimed=await dispatch();assert.equal(reclaimed.claimed,1);assert.equal(reclaimed.sent,1);
    const late=check(await service.rpc('push_outbox_complete',{results:[{id:dead.items[0].id,claim_id:dead.items[0].claim_id,
      deliveries:[{device_id:dead.items[0].devices[0].id,outcome:'invalid'}]}]}),'late completion');
    assert.deepEqual(late,{completed:0,stale:1});assert.equal(devices(2),'a1,a2!','late invalid ignored');
    assert.equal(sql(`select status||':'||attempts from private.notification_outbox where id='${dead.items[0].id}'`),'sent:2');
    console.log('PASS: a dead worker’s expired lease is reclaimed and sent once (attempt 2); its late “invalid” reply is stale and changes nothing.');

    // Receipts: 15 minutes after sending, a DeviceNotRegistered receipt disables the owner's phone; the app registering again re-enables it.
    const ownerTicket=[...ticketToken].find(([,to])=>to===pushToken('owner'))[0];
    sql(`update private.push_deliveries set sent_at=clock_timestamp()-interval '16 minutes' where ticket_id in (select ticket_id from private.push_deliveries p
      join private.notification_outbox o on o.id=p.outbox_id where o.payload->>'venue_id'='${venue}');`);
    receiptPlan=id=>id===ownerTicket?{status:'error',message:'gone',details:{error:'DeviceNotRegistered'}}:{status:'ok'};
    const receipts=await dispatch();assert.equal(receipts.receipts,expoLog.receiptRequests.at(-1).length);assert.ok(receipts.receipts>=30);
    assert.equal(devices(0),'owner!');assert.equal(sql(`select count(*) from private.push_deliveries where receipt is null and ticket_id like 'T-%'`),'0');
    assert.equal((await dispatch()).receipts,0,'receipts recorded once');
    assert.equal((await mobile.registerPushDevice(transport(0),pushToken('owner'),'ios')).ok,true);assert.equal(devices(0),'owner');
    console.log(`PASS: ${receipts.receipts} receipts recorded once; DeviceNotRegistered disabled the owner's phone and re-registering enabled it.`);

    // The cron hook: nothing due → no call; work due without Vault configuration → not_configured. pg_cron schedules the named job idempotently.
    assert.equal(sql('select private.push_dispatch_kick() is null;'),'t');
    assert.equal(change(1,bookings[8],'decline'),'declined');
    assert.match(String((()=>{try{sql('select private.push_dispatch_kick();');return 'ran';}catch(e){return e.stderr;}})()),/Push dispatch is not configured/);
    sql(`update private.notification_outbox set status='dropped',last_error='stale',finished_at=clock_timestamp() where payload->>'venue_id'='${venue}' and status='pending';`);
    if(!cronInstalled()){sql('create extension pg_cron;');cronCreated=true;}
    const hadJob=sql(`select exists(select 1 from cron.job where jobname='push-dispatch')`)==='t';
    const jobId=sql('select private.push_dispatch_schedule();');assert.equal(sql('select private.push_dispatch_schedule();'),jobId);
    assert.deepEqual(JSON.parse(sql(`select jsonb_build_object('schedule',schedule,'command',command,'active',active) from cron.job where jobid=${jobId}`)),
      {schedule:'* * * * *',command:'select private.push_dispatch_kick()',active:true});
    if(!hadJob)sql(`select cron.unschedule('push-dispatch');`);
    console.log('PASS: kick is a no-op with nothing due and refuses (not_configured) without Vault secrets; pg_cron push-dispatch job (every minute) is idempotent.');

    // Account deletion through Auth removes the account's devices and pending rows.
    check(await service.auth.admin.deleteUser(users[3]),'Delete racer');assert.equal(sql(`select count(*) from private.push_devices where user_id='${users[3]}'`),'0');

    // Serve the actual pinned Deno Edge runtime with Redis deliberately absent. Nothing may be due: the served worker would call the real Expo.
    const envPath=path.join(temp,'functions.env');
    fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\nPUSH_WORKER_SECRET=${secret}\n`);
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    child=spawn(cli,['functions','serve','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const invoke=(name,auth,init={})=>fetch(new URL(`functions/v1/${name}`,api).href,{method:'POST',...init,
      headers:{apikey:config.ANON_KEY,'content-type':'application/json',...(auth?{authorization:`Bearer ${auth}`}:{}),...init.headers},signal:AbortSignal.timeout(20000)});
    let ready=false;for(let n=0;n<120;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{const current=edgeId();if(current&&current!==staleEdge&&(await invoke('push-devices',null,{body:'{}'})).status===401){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,500));}
    assert.ok(ready,'Fresh Edge ready');
    const body=JSON.stringify({kind:'register',token:pushToken('served'),platform:'ios'});
    assert.equal((await invoke('push-devices',forged,{body})).status,401);assert.equal((await invoke('push-devices',tokens[5],{method:'GET',body:undefined})).status,405);
    const served=await invoke('push-devices',tokens[5],{body});assert.equal(served.status,200,'Redis absent: registration continues');assert.deepEqual(await served.json(),{status:'registered'});
    assert.equal(devices(5),'served');
    assert.equal((await invoke('push-dispatch',null,{body:'{}'})).status,401);assert.equal((await invoke('push-dispatch',tokens[5],{body:'{}'})).status,401);
    assert.equal((await invoke('push-dispatch',secret,{method:'GET',body:undefined})).status,405);
    assert.equal(sql(`select count(*) from private.notification_outbox where status in ('pending','sending')`),'0','nothing due before the served worker');
    assert.equal(sql(`select count(*) from private.push_deliveries where receipt is null`),'0','no receipts due before the served worker');
    const servedRun=await invoke('push-dispatch',secret,{body:'{}'});assert.equal(servedRun.status,200);
    assert.deepEqual(await servedRun.json(),{claimed:0,sent:0,retried:0,invalid:0,failed:0,stale:0,receipts:0});
    console.log('PASS: actual served Edge: push-devices forged 401, GET 405, register 200 with Redis absent; push-dispatch no/user bearer 401, GET 405, worker secret 200 with nothing due.');
  }finally{
    if(child&&child.exitCode===null)child.kill();if(fake)fake.close();let clean=true;const steps=[];
    if(cronCreated)steps.push(()=>sql('drop extension pg_cron;'));
    if(created)steps.push(()=>sql(`delete from public.venues where id='${venue}';`));
    for(const id of users)steps.push(async()=>{const r=await service.auth.admin.deleteUser(id);assert.ok(!r.error||r.error.status===404,'Own account cleanup');});
    steps.push(()=>sql(`delete from private.notification_outbox where payload->>'venue_id'='${venue}';delete from private.directory_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-push-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,anon,...clients])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own fixtures/accounts/devices/outbox/cron state/temp removed; pre-existing IDs preserved; the real Expo service was never called; no hosted changes.');
}
main().catch(error=>{console.error(`Local notifications check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;});
