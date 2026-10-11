// T51a: real local Docker/Auth/PostgREST, served Edge functions with Redis absent, real pg_cron and pg_net calling the served
// ops-monitor, and a fake Discord webhook plus heartbeat on loopback (never the real Discord). Simulated failures must reach the
// fake channel end to end and recover with one post each. No hosted or mobile env.
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const http=require('node:http');
const {randomUUID,randomBytes}=require('node:crypto');const {execFile,execFileSync,spawn}=require('node:child_process');const {createClient}=require('@supabase/supabase-js');
const {OPS_CHECKS}=require('../../packages/domain/src/ops.ts');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
  const context=run(['context','show']).trim();const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const args=['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'];
  const sql=query=>run(args,query).trim();
  const extension=name=>sql(`select exists(select 1 from pg_extension where extname='${name}')`)==='t';
  const cronAtStart=extension('pg_cron');const netAtStart=extension('pg_net');
  const jobNames=['booking-expiry-sweep','push-dispatch','privacy-retention-sweep','ops-monitor'];
  if(cronAtStart)assert.equal(sql(`select count(*) from cron.job where jobname in (${jobNames.map(n=>`'${n}'`).join(',')})`),'0','Run on a database without the four monitored jobs');
  assert.equal(sql(`select count(*) from vault.secrets where name in ('ops_monitor_url','ops_monitor_secret')`),'0','Run on a database without ops monitor Vault secrets');
  const inventory=()=>sql(`select jsonb_build_object('users',(select jsonb_agg(id order by id) from auth.users),'venues',(select jsonb_agg(id order by id) from public.venues),
    'allocations',(select jsonb_agg(id order by id) from private.court_allocations),'outbox',(select jsonb_agg(id order by id) from private.notification_outbox),
    'deletions',(select jsonb_agg(user_id order by user_id) from private.account_deletions),'merchants',(select jsonb_agg(venue_id order by venue_id) from private.venue_merchants),
    'state',(select jsonb_agg(to_jsonb(s) order by check_name) from private.ops_alert_state s),'signals',(select jsonb_agg(to_jsonb(s) order by minute,source,kind) from private.ops_signals s),
    'vault',(select jsonb_agg(name order by name) from vault.secrets),'extensions',(select jsonb_agg(extname order by extname) from pg_extension));`);
  const beforeInventory=inventory();const before=JSON.parse(beforeInventory);
  const literal=value=>`'${JSON.stringify(value??[]).replace(/'/g,"''")}'::jsonb`;
  // Signals this run created; the snapshot's rows stay.
  const ownSignals=`delete from private.ops_signals s where not exists (select 1 from jsonb_populate_recordset(null::private.ops_signals,${literal(before.signals)}) o
    where o.minute=s.minute and o.source=s.source and o.kind=s.kind);`;
  if(!cronAtStart){
    run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'ops-monitoring.sql'),'utf8'));
    console.log('PASS: Docker ops-monitoring SQL: grants, signal bounds, every check failing and recovering on cue, real flows consistent, alert state (post until confirmed, changes, six-hour reminders, recoveries, stale confirmations), Redis input, retention.');
  }else console.log('SKIP: Docker ops-monitoring SQL needs a database without pg_cron (it brings its own stand-in); npm run test:ops covers it on PGlite.');

  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const check=(r,message)=>{assert.ok(!r.error,`${message}: ${r.error?.message??''}`);return r.data;};
  const users=[],tokens=[],clients=[];const venue=randomUUID();const court=randomUUID();const key=()=>randomUUID();
  let created=false,child,cronCreated=false,netCreated=false,vaultCreated=false;const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-ops-'));
  // Other harnesses' served functions leave signals behind; start from a quiet state (both tables are restored at the end).
  sql('delete from private.ops_alert_state;delete from private.ops_signals;');

  // Fake Discord webhook and heartbeat on loopback; containers reach it through host.docker.internal.
  const posts=[];const pings=[];let discordMode='ok';
  const fake=http.createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{
    if(req.method==='GET'&&req.url==='/ping'){pings.push(Date.now());res.writeHead(200);return res.end('OK');}
    if(req.method==='POST'&&req.url==='/api/webhooks/1/fake?wait=true'){
      const json=JSON.parse(body);posts.push({at:Date.now(),ok:discordMode==='ok',json});
      if(discordMode!=='ok'){res.writeHead(500,{'content-type':'application/json'});return res.end('{"message":"down"}');}
      res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({id:String(posts.length)}));
    }
    res.writeHead(404);res.end();
  });});
  await new Promise(r=>fake.listen(0,'127.0.0.1',r));const port=fake.address().port;
  // "label → check" for reading posted lines back.
  const byLabel=new Map(Object.entries(OPS_CHECKS).map(([name,c])=>[c.label,name]));
  const parse=content=>content.split('\n').slice(1).map(line=>{
    const m=/^(🔴 FAIL|🟡 WARN|✅ RESOLVED|🔴 STILL FAILING|🟡 STILL WARNING)(?: \(was [A-Z]+\))?(?: since .+? \(Manila\))? · ([^:]+?)(?:: .*)?$/u.exec(line);
    assert.ok(m&&byLabel.has(m[2]),`unexpected line: ${line}`);
    return {check:byLabel.get(m[2]),status:m[1].includes('RESOLVED')?'ok':m[1].includes('WARN')?'warn':'fail'};
  });
  const delivered=()=>posts.filter(p=>p.ok);
  const seen=(from,status)=>new Set(delivered().slice(from).flatMap(p=>parse(p.json.content)).filter(l=>status==='ok'?l.status==='ok':l.status!=='ok').map(l=>l.check));
  const waitFor=async(predicate,label,timeout=150000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(1000);}assert.fail(`Timed out waiting for ${label}`);};
  try{
    // Accounts: 0 owner, 1 player.
    for(let n=0;n<2;n++){
      const credentials={email:`ops-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own account').user.id);
      const c=createClient(api.href,config.ANON_KEY,options);clients.push(c);tokens.push(check(await c.auth.signInWithPassword(credentials),'Own login').session.access_token);
    }
    const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Ops Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);created=true;
    sql(`insert into public.courts(id,venue_id,name) values('${court}','${venue}','A');
      insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');
      insert into private.venue_policies(venue_id,confirmation,payment) values('${venue}','approval','arrival');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',0,'end_minute',1440,'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));`);
    const hold=JSON.parse(sql(`select public.rental_booking_request('${users[1]}','${court}','${key()}','${at(480)}','${at(540)}',
      public.rental_booking_quote('${users[1]}','${court}','${at(480)}','${at(540)}')->'expected_quote')::text;`)).booking;
    assert.equal(hold.status,'pending');
    const session=JSON.parse(sql(`select public.owner_session_create('${users[0]}',jsonb_build_object('venue_id','${venue}','request_id','${key()}',
      'court_ids',jsonb_build_array('${court}'),'title','Ops play','starts_at','${at(600)}','ends_at','${at(720)}','capacity',8,'group_limit',4,'price_centavos',20000))::text;`)).session;

    // Serve the pinned Edge runtime with Redis deliberately absent and the fake channel as the webhook.
    const secret=randomBytes(32).toString('base64url');
    const envPath=path.join(temp,'functions.env');
    fs.writeFileSync(envPath,[`DISCOVERY_SUPABASE_URL=http://kong:8000`,`DISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}`,`DISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}`,
      'PICKLY_ENV=local',`OPS_MONITOR_SECRET=${secret}`,`OPS_ALERT_WEBHOOK_URL=http://host.docker.internal:${port}/api/webhooks/1/fake`,
      `OPS_HEARTBEAT_URL=http://host.docker.internal:${port}/ping`,''].join('\n'));
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    child=spawn(cli,['functions','serve','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const invoke=(name,auth,init={})=>fetch(new URL(`functions/v1/${name}`,api).href,{method:'POST',...init,
      headers:{apikey:config.ANON_KEY,'content-type':'application/json',...(auth?{authorization:`Bearer ${auth}`}:{}),...init.headers},signal:AbortSignal.timeout(30000)});
    let ready=false;for(let n=0;n<120;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{const current=edgeId();if(current&&current!==staleEdge&&(await invoke('ops-monitor',null,{body:'{}'})).status===401){ready=true;break;}}catch{}
      await sleep(500);}
    assert.ok(ready,'Fresh Edge ready');
    assert.equal((await invoke('ops-monitor',secret,{method:'GET',body:undefined})).status,405);
    assert.equal((await invoke('ops-monitor',tokens[1],{body:'{}'})).status,401,'a user token is refused');
    assert.equal((await invoke('ops-monitor',randomBytes(32).toString('base64url'),{body:'{}'})).status,401,'a wrong secret is refused');
    assert.equal(posts.length,0,'nothing posted for refused calls');
    console.log('PASS: served ops-monitor: GET 405, user token and wrong secret 401, nothing posted.');

    // Real signals from served functions with Redis absent: a guest search continues unthrottled, a report is refused (fail closed).
    assert.equal((await invoke('venue-search?city=Manila',null,{method:'GET',body:undefined})).status,200,'discovery continues without Redis');
    const report=await invoke('venue-reports',tokens[1],{body:JSON.stringify({request_id:key(),venue_id:venue,reason:'wrong_details',details:null})});
    assert.equal(report.status,503,'report creation fails closed without Redis');
    await waitFor(()=>sql(`select count(*) from private.ops_signals where (source,kind) in (('venue-search','limiter_degraded'),('venue-reports','limiter_degraded'),('venue-reports','unavailable'))`)==='3',
      'served signals',20000);
    console.log('PASS: served venue-search (200) and venue-reports (503) with Redis absent recorded limiter_degraded and unavailable signals through ops_signal_record, without changing their answers.');

    // Without Vault the cron caller refuses; a direct run reports what is wrong now and posts it once.
    assert.match(String((()=>{try{sql('select private.ops_monitor_kick();');return 'ran';}catch(e){return e.stderr;}})()),/Ops monitor is not configured/);
    const first=await invoke('ops-monitor',secret,{body:'{}'});assert.equal(first.status,200,'direct run');
    const firstBody=await first.json();assert.equal(firstBody.alerts,3);
    assert.equal(delivered().length,1);assert.deepEqual([...seen(0,'fail')].sort(),['cron.jobs','edge.limiter','redis.reachable']);
    const firstPost=delivered()[0].json;
    assert.deepEqual(Object.keys(firstPost).sort(),['allowed_mentions','content','username']);assert.deepEqual(firstPost.allowed_mentions,{parse:[]});
    assert.match(firstPost.content,/^\*\*PicklyPH local\*\* monitor: 3 problems\n/);
    assert.match(firstPost.content,/Scheduled jobs: 4 expected pg_cron jobs are missing or inactive/);
    assert.equal(pings.length,1,'heartbeat after the run');
    assert.equal(sql(`select string_agg(check_name||'='||notified_status,',' order by check_name) from private.ops_alert_state where status<>'ok'`),
      'cron.jobs=fail,edge.limiter=fail,redis.reachable=fail','posted states confirmed');
    const second=await invoke('ops-monitor',secret,{body:'{}'});assert.equal(second.status,200);assert.equal((await second.json()).alerts,0);
    assert.equal(posts.length,1,'no repeat');assert.equal(pings.length,2);
    console.log('PASS: kick refuses without Vault (not_configured); a direct run posted one message (pg_cron jobs missing, Redis limiter outage, Redis unreachable), confirmed it and pinged the heartbeat; the next run posted nothing.');

    // pg_net, Vault and pg_cron: the real path. Every-minute jobs first, so none looks stalled when the monitor starts.
    if(!netAtStart){sql('create extension pg_net;');netCreated=true;}
    if(!cronAtStart){sql('create extension pg_cron;');cronCreated=true;}
    sql(`select vault.create_secret('http://kong:8000/functions/v1/ops-monitor','ops_monitor_url');select vault.create_secret('${secret}','ops_monitor_secret');`);vaultCreated=true;
    sql('select private.booking_expiry_schedule();select private.privacy_retention_schedule();select private.push_dispatch_schedule();');
    const lastSuccess=name=>sql(`select coalesce(max(d.start_time)::text,'') from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='${name}' and d.status='succeeded'`);
    await waitFor(()=>lastSuccess('booking-expiry-sweep')!==''&&lastSuccess('push-dispatch')!=='','every-minute jobs to succeed once',130000);
    const jobId=sql('select private.ops_monitor_schedule();');assert.equal(sql('select private.ops_monitor_schedule();'),jobId,'idempotent');
    assert.equal(sql(`select schedule||' | '||command from cron.job where jobid=${jobId}`),'*/5 * * * * | select private.ops_monitor_kick()');
    // Faster for this run only: the same job every 20 seconds.
    sql(`select cron.schedule('ops-monitor','20 seconds','select private.ops_monitor_kick()');`);
    const recovered=delivered().length;
    await waitFor(()=>seen(recovered,'ok').has('cron.jobs'),'a cron-driven run to post the jobs recovery');
    assert.ok(Number(sql(`select count(*) from net._http_response where status_code=200`))>=1,'pg_net got 200 from the served monitor');
    assert.ok(Number(sql(`select count(*) from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='ops-monitor' and d.status='succeeded'`))>=1);
    console.log('PASS: pg_cron (ops-monitor */5, run every 20 s here) → private.ops_monitor_kick → pg_net with Vault URL/secret → served ops-monitor → fake Discord posted "Scheduled jobs" RESOLVED.');

    // Simulated failures, all at once (trusted SQL stands in for time passing and operator mistakes).
    const failuresFrom=delivered().length;
    const job=name=>sql(`select jobid from cron.job where jobname='${name}'`);
    sql(`select cron.alter_job(${job('privacy-retention-sweep')},active:=false);`);
    sql(`select cron.alter_job(${job('booking-expiry-sweep')},schedule:='0 0 1 1 *');
      update cron.job_run_details set start_time=start_time-interval '11 minutes',end_time=end_time-interval '11 minutes' where jobid=${job('booking-expiry-sweep')};`);
    sql(`update private.court_allocations set expires_at=clock_timestamp()-interval '11 minutes' where id='${hold.id}';`);
    sql(`update private.open_play_sessions set reserved_spots=reserved_spots+1 where id='${session.id}';`);
    // A due row the push worker cannot send (no push Vault secrets locally): the outbox backs up and push-dispatch runs fail.
    sql(`insert into private.notification_outbox(source,event_id,recipient_user_id,kind,payload,next_attempt_at) values
        ('rental',990001,'${users[1]}','booking.accepted','{}',clock_timestamp()-interval '11 minutes');
      insert into private.notification_outbox(source,event_id,recipient_user_id,kind,payload,status,attempts,last_error,finished_at) values
        ('rental',990002,'${users[1]}','booking.accepted','{}','failed',1,'invalid_credentials',clock_timestamp());
      insert into private.account_deletions(user_id,requested_at) values('${users[1]}',clock_timestamp()-interval '2 hours');
      insert into private.venue_merchants(venue_id,active) values('${venue}',true);`);
    check(await service.rpc('ops_signal_record',{signal_source:'rental-bookings',signal_kind:'server_error',occurrences:5}),'service records a signal like the functions do');
    const injected=['cron.jobs','cron.failures','cron.stalled','holds.overdue','inventory.mismatch','push.backlog','push.credentials','edge.errors','privacy.deletions','rollout.arrival_only'];
    await waitFor(()=>injected.every(name=>seen(failuresFrom,'fail').has(name)),'every simulated failure to be posted',200000);
    const failurePosts=delivered().slice(failuresFrom);
    for(const p of failurePosts){
      assert.doesNotMatch(p.json.content,/[0-9a-f]{8}-[0-9a-f]{4}-|@|Local Ops Fixture|ExponentPushToken|Bearer|eyJ/i,'counts only: no IDs, emails, names, tokens');
      assert.ok(p.json.content.length<=2000);
    }
    assert.deepEqual([...seen(failuresFrom,'fail')].filter(n=>!injected.includes(n)),[],'nothing else failed');
    console.log(`PASS: ${injected.length} simulated failures (inactive and stalled jobs, failing push-dispatch runs, overdue hold, corrupted spot counter, backed-up outbox, push credential failure, 5 Edge 5xx, unfinished deletion, active merchant) reached the fake channel through pg_cron/pg_net in ${failurePosts.length} posts, counts only.`);

    // Restore everything; each problem posts one recovery.
    const recoveriesFrom=delivered().length;const restoredAt=sql('select clock_timestamp()::text');
    sql(`select cron.alter_job(${job('privacy-retention-sweep')},active:=true);select cron.alter_job(${job('booking-expiry-sweep')},schedule:='* * * * *');
      update private.open_play_sessions set reserved_spots=reserved_spots-1 where id='${session.id}';
      delete from private.notification_outbox where event_id in (990001,990002) and recipient_user_id='${users[1]}';
      delete from private.account_deletions where user_id='${users[1]}';delete from private.venue_merchants where venue_id='${venue}';${ownSignals}`);
    // Failed runs age out after 15 minutes; once push-dispatch has succeeded again, drop them instead of waiting.
    await waitFor(()=>lastSuccess('push-dispatch')>restoredAt,'push-dispatch to succeed after the restore',90000);
    sql(`delete from cron.job_run_details where status='failed' and jobid in (select jobid from cron.job where jobname in (${jobNames.map(n=>`'${n}'`).join(',')}));`);
    const recovering=[...injected,'edge.limiter'];
    await waitFor(()=>recovering.every(name=>seen(recoveriesFrom,'ok').has(name)),'every recovery to be posted',200000);
    assert.equal(sql(`select status from private.rental_bookings where id='${hold.id}'`),'expired','the restored sweep expired the overdue hold');
    assert.equal(sql(`select string_agg(check_name,',' order by check_name) from private.ops_alert_state where status<>'ok' or notified_status is distinct from status and notified_status is not null`),
      'redis.reachable','only Redis (absent here) is still failing, and it was posted');
    const quietFrom=delivered().length;const pingMark=pings.length;
    await waitFor(()=>pings.length>=pingMark+2,'two quiet runs',90000);
    assert.equal(delivered().length,quietFrom,'no repeats once everything recovered');
    console.log(`PASS: restored → ${recovering.length} recoveries posted once each (the sweep, back on schedule, expired the overdue hold); two later runs posted nothing.`);

    // Discord refusing: the alert stays unconfirmed, no heartbeat, and the next run after Discord recovers posts it.
    discordMode='fail';const refusedFrom=posts.length;
    sql(`insert into private.venue_merchants(venue_id,active) values('${venue}',true);`);
    await waitFor(()=>posts.slice(refusedFrom).some(p=>!p.ok&&/Arrival-only pilot/.test(p.json.content)),'a refused post');
    const pingsBefore=pings.length;
    await waitFor(()=>posts.slice(refusedFrom).filter(p=>!p.ok).length>=2,'a second refused attempt',60000);
    assert.equal(pings.length,pingsBefore,'no heartbeat while Discord refuses');
    assert.equal(sql(`select status||'/'||notified_status from private.ops_alert_state where check_name='rollout.arrival_only'`),'fail/ok','still unconfirmed');
    assert.ok(Number(sql(`select count(*) from net._http_response where status_code=502`))>=1,'pg_net saw delivery_failed');
    discordMode='ok';const retryFrom=delivered().length;
    await waitFor(()=>seen(retryFrom,'fail').has('rollout.arrival_only'),'the retried post');
    assert.equal(sql(`select status||'/'||notified_status from private.ops_alert_state where check_name='rollout.arrival_only'`),'fail/fail','confirmed after delivery');
    sql(`delete from private.venue_merchants where venue_id='${venue}';`);
    const finalFrom=delivered().length;await waitFor(()=>seen(finalFrom,'ok').has('rollout.arrival_only'),'the recovery');
    console.log('PASS: Discord 500 → attempts left unconfirmed (pg_net logged 502), no heartbeat; after Discord recovered the next run posted the alert, then its recovery.');
  }finally{
    if(child&&child.exitCode===null)child.kill();fake.close();let clean=true;const steps=[];
    if(cronAtStart)steps.push(()=>sql(`select cron.unschedule(jobname) from cron.job where jobname in (${jobNames.map(n=>`'${n}'`).join(',')});`));
    if(cronCreated)steps.push(()=>sql('drop extension pg_cron;'));
    if(netCreated)steps.push(()=>sql('drop extension pg_net;'));
    if(vaultCreated)steps.push(()=>sql(`delete from vault.secrets where name in ('ops_monitor_url','ops_monitor_secret');`));
    if(users[1])steps.push(()=>sql(`delete from private.account_deletions where user_id='${users[1]}';delete from private.notification_outbox where recipient_user_id='${users[1]}';`));
    if(created)steps.push(()=>sql(`delete from public.venues where id='${venue}';delete from private.directory_audit_events where target_venue_id='${venue}';`));
    for(const id of users)steps.push(async()=>{const r=await service.auth.admin.deleteUser(id);assert.ok(!r.error||r.error.status===404,'Own account cleanup');});
    // Alert state and signals go back to exactly what was there before.
    steps.push(()=>{
      sql(`delete from private.ops_alert_state;insert into private.ops_alert_state select * from jsonb_populate_recordset(null::private.ops_alert_state,${literal(before.state)});
        delete from private.ops_signals;insert into private.ops_signals select * from jsonb_populate_recordset(null::private.ops_signals,${literal(before.signals)});`);});
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-ops-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,...clients])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own fixtures/accounts/signals/alert state/Vault secrets/cron jobs/extensions/temp removed; pre-existing IDs preserved; the real Discord was never called; no hosted changes.');
}
main().catch(error=>{console.error(`Local ops monitoring check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;});
