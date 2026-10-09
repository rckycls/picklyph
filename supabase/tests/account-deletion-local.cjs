// T47: real local Docker/Auth/Storage/PostgREST, the shipped deletion handler and mobile client, observed lock orders and served Edge. No hosted/mobile env.
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
  const cronInstalled=()=>sql(`select exists(select 1 from pg_extension where extname='pg_cron')`)==='t';
  const cronJobs=()=>cronInstalled()?sql(`select coalesce(jsonb_agg(jsonb_build_array(jobid,jobname,schedule,command,active) order by jobid),'[]') from cron.job`):'none';
  const inventory=()=>sql(`select jsonb_build_object('users',(select jsonb_agg(id order by id) from auth.users),'profiles',(select jsonb_agg(id order by id) from public.profiles),
    'deletions',(select jsonb_agg(user_id order by user_id) from private.account_deletions),'venues',(select jsonb_agg(id order by id) from public.venues),
    'owners',(select jsonb_agg(venue_id::text||user_id::text order by venue_id,user_id) from private.venue_owners),
    'roles',(select jsonb_agg(user_id::text||role::text order by user_id,role) from private.account_roles),
    'allocations',(select jsonb_agg(id order by id) from private.court_allocations),'groups',(select jsonb_agg(id order by id) from private.session_bookings),
    'reports',(select jsonb_agg(id order by id) from private.venue_reports),'moderation',(select jsonb_agg(id order by id) from private.moderation_audit_events),
    'audit',(select jsonb_agg(id order by id) from private.directory_audit_events),
    'objects',(select jsonb_agg(bucket_id||'/'||name order by bucket_id,name) from storage.objects where bucket_id in ('avatars','owner-evidence')));`)+cronJobs();
  const beforeInventory=inventory();
  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'account-deletion.sql'),'utf8'));
  console.log('PASS: Docker deletion SQL: console refusal, booking cancellation, name erasure, venue release, draft retirement, in-progress guards, cascades, report retention.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(r,message)=>{assert.ok(!r.error,message);return r.data;};const users=[],clients=[],tokens=[];const venue=randomUUID();
  const courts=[randomUUID(),randomUUID()].sort();let created=false;let child;let cronCreated=false,scheduled=false,jobBefore=null,checkJob=null;const workers=new Set();const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-deletion-'));
  const dbSession=query=>new Promise(resolve=>{
    const worker=spawn(docker,args,{windowsHide:true});workers.add(worker);let out='',err='';
    worker.stdout.on('data',d=>out+=d);worker.stderr.on('data',d=>err+=d);
    worker.on('error',()=>resolve({code:-1,out,err}));worker.on('close',code=>{workers.delete(worker);resolve({code,out:out.trim(),err});});worker.stdin.end(query);
  });
  // The holder keeps its locks while sleeping; the competitor is started only once the holder is observed asleep.
  const heldRace=async(first,second)=>{
    const name=`pickly-deletion-${randomUUID()}`;
    const holder=dbSession(`set application_name='${name}';begin;${first}select pg_sleep(1.89);commit;`);
    let observed=false;
    for(let n=0;n<100&&!observed;n++){
      observed=sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event='PgSleep'`)==='1';
      if(!observed)await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(observed,'Observed holder locks');const competitor=await dbSession(second);const winner=await holder;assert.equal(winner.code,0,'Holder committed');return competitor;
  };
  const handlerModule=load(path.join(__dirname,'../functions/account-deletion/handler.ts'),{},{TextDecoder});
  const {createSupabaseAccountDeletionDeps}=load(path.join(__dirname,'../functions/account-deletion/deps.ts'),{'./handler.ts':handlerModule},{TextDecoder,atob});
  const root=path.resolve(__dirname,'../..');
  const mobile=load(path.join(root,'src/features/account/deletionClient.ts'),{'@picklyph/domain':require(path.join(root,'packages/domain/src/privacy.ts')),
    '../owner/venueClient':require(path.join(root,'src/features/owner/venueClient.ts'))});
  const recovery=require(path.join(root,'src/lib/recoveryKeys.ts'));
  const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();
  const quote=(user,court,a,b)=>JSON.parse(sql(`select public.rental_booking_quote('${users[user]}','${court}','${at(a)}','${at(b)}')->'expected_quote';`));
  const rentSql=(user,court,a,b,expected,key=randomUUID())=>`select public.rental_booking_request('${users[user]}','${court}','${key}','${at(a)}','${at(b)}',${literal(expected)});`;
  const rentalStatus=user=>sql(`select coalesce(string_agg(b.status,',' order by a.starts_at),'') from private.court_allocations a join private.rental_bookings b on b.id=a.id where a.requested_by='${users[user]}'`);
  const objects=user=>sql(`select count(*) from storage.objects where bucket_id in ('avatars','owner-evidence') and name like '${users[user]}/%'`);
  const authUser=async user=>{const r=await service.auth.admin.getUserById(users[user]);return r.error?null:r.data.user.id;};
  try{
    // Accounts: 0 owner, 1 player deleted through the shipped handler/client, 2 player who stays, 3 admin, 4-5 lock-order players, 6 served-Edge player.
    for(let n=0;n<7;n++){
      const credentials={email:`deletion-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own account').user.id);
      const c=createClient(api.href,config.ANON_KEY,options);clients.push(c);tokens.push(check(await c.auth.signInWithPassword(credentials),'Own login').session.access_token);
    }
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Deletion Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);created=true;
    sql(`insert into public.courts(id,venue_id,name) values('${courts[0]}','${venue}','A'),('${courts[1]}','${venue}','B');
      insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');
      insert into private.account_roles(user_id,role) values('${users[3]}','admin');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',0,'end_minute',1440,'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));`);
    sql(rentSql(1,courts[0],600,660,quote(1,courts[0],600,660)));sql(rentSql(2,courts[0],660,720,quote(2,courts[0],660,720)));
    const session=check(await service.rpc('owner_session_create',{actor_user_id:users[0],session_input:{venue_id:venue,request_id:randomUUID(),court_ids:[courts[1]],
      title:'Deletion play',starts_at:at(840),ends_at:at(960),capacity:8,group_limit:4,price_centavos:25000}}),'Own session').session.id;
    check(await service.rpc('session_booking_request',{actor_user_id:users[1],booking_input:{session_id:session,request_id:randomUUID(),participants:['Ana','Ben'],expected_total_centavos:50000}}),'Own group A');
    check(await service.rpc('session_booking_request',{actor_user_id:users[2],booking_input:{session_id:session,request_id:randomUUID(),participants:['Cy'],expected_total_centavos:25000}}),'Own group B');
    // Player 1's private photo (own client, storage policy) and server-stored evidence, both under the account folder.
    const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0,16,0x4a,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0,0xff,0xd9]);const avatar=`${users[1]}/${randomUUID()}.jpg`;
    check(await clients[1].storage.from('avatars').upload(avatar,jpeg,{contentType:'image/jpeg'}),'Own avatar');
    check(await clients[1].from('profiles').update({avatar_path:avatar,first_name:'Delete',last_name:'Me',phone:'+639171234567'}).eq('id',users[1]),'Own profile');
    for(let n=0;n<2;n++)check(await service.storage.from('owner-evidence').upload(`${users[1]}/${randomUUID()}.jpg`,jpeg,{contentType:'image/jpeg'}),'Own evidence');
    assert.equal(objects(1),'3');
    const enforced=async()=>({allowed:true,status:200,state:'enforced',headers:{}});const server=()=>createClient(api.href,config.SERVICE_ROLE_KEY,options);
    const deletion=handlerModule.createAccountDeletionHandler({...createSupabaseAccountDeletionDeps(()=>anon,server),limit:enforced});
    const send=(user,body={confirm:'delete_account'},token=tokens[user])=>deletion(new Request('https://local.test',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}));
    // Console accounts, forged tokens and smuggled actors are refused with nothing changed.
    const refused=await send(3);assert.equal(refused.status,403);assert.deepEqual(await refused.json(),{error:'privileged_account'});
    assert.equal(sql(`select public.account_deletion_status('${users[3]}')`),'none');assert.ok(await authUser(3));
    const forged=`${tokens[1].split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[1],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await send(1,undefined,forged)).status,401);assert.equal((await send(1,{confirm:'delete_account',actor_user_id:users[2]})).status,400);
    assert.equal(sql(`select count(*) from private.account_deletions where user_id in ('${users[1]}','${users[2]}')`),'0');
    console.log('PASS: real API console account 403 privileged_account with no deletion record; forged JWT 401; smuggled actor 400.');
    // The shipped mobile client: the reply is lost after the deletion finished; the retry's token outlived the account and is confirmed.
    let loseReply=true;
    const transport={endpoint:'https://local.test',apiKey:config.ANON_KEY,accessToken:async()=>tokens[1],fetch:async(url,init)=>{
      const response=await deletion(new Request(url,init));if(loseReply){loseReply=false;throw new Error('Lost reply after commit');}
      return {ok:response.ok,status:response.status,headers:response.headers,json:()=>response.json()};
    }};
    assert.equal((await mobile.deleteAccount(transport)).failure.kind,'network');
    assert.equal(await authUser(1),null,'Auth user deleted');assert.equal(objects(1),'0','avatar and evidence folders emptied');
    assert.equal(sql(`select count(*) from public.profiles where id='${users[1]}'`),'0');assert.equal(rentalStatus(1),'cancelled');
    assert.equal(sql(`select string_agg(status||':'||participants::text,';') from private.session_bookings where requested_by='${users[1]}'`),'cancelled:["Guest 1", "Guest 2"]');
    assert.equal(sql(`select string_agg(participants::text,';') from private.session_bookings where requested_by='${users[2]}'`),'["Cy"]');assert.equal(rentalStatus(2),'confirmed');
    const recovered=await mobile.deleteAccount(transport);assert.equal(recovered.ok,true,'GoTrue user_not_found + deletion record confirm the retry');
    assert.equal(recovered.value.status,'deleted');assert.equal(sql(`select public.account_deletion_status('${users[1]}')`),'deleted');
    const device=new Map([...recovery.accountRecoveryKeys(api.href,users[1]),...recovery.accountRecoveryKeys(api.href,users[2])].map(k=>[k,'{}']));
    await recovery.clearAccountRecovery({remove:async k=>{device.delete(k);}},api.href,users[1]);
    assert.deepEqual([...device.keys()].sort(),recovery.accountRecoveryKeys(api.href,users[2]).sort());
    console.log('PASS: shipped client: lost reply after a finished deletion (Auth user, avatar/evidence objects and profile gone; rental cancelled; group names erased); retry confirmed through real GoTrue user_not_found; device keys for that account cleared.');
    // Owner deletion: the sole owner releases the listing (unclaimed, audited); the other player's booking stays.
    const owner=await send(0);assert.equal(owner.status,200);assert.equal(await authUser(0),null);
    assert.equal(sql(`select publication_status::text||'/'||claim_status::text from public.venues where id='${venue}'`),'approved/unclaimed');
    assert.equal(sql(`select string_agg(action||':'||reason||':'||(actor_user_id=subject_id)::text,',') from private.moderation_audit_events where target_venue_id='${venue}'`),'owner.revoke:owner_request:true');
    assert.equal(rentalStatus(2),'confirmed');assert.equal(sql(`select status from private.open_play_sessions where id='${session}'`),'scheduled');
    console.log('PASS: real API owner deletion releases the sole-owned listing (unclaimed, one self revocation audit row); other bookings and the session stay.');
    // Observed lock orders, both ways (the venue is re-verified with a stand-in owner so new bookings are possible).
    sql(`insert into private.venue_owners(user_id,venue_id) values('${users[2]}','${venue}');update public.venues set claim_status='verified' where id='${venue}';`);
    let competitor=await heldRace(`select public.account_deletion_begin('${users[4]}');`,rentSql(4,courts[1],600,660,quote(4,courts[1],600,660)));
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Account deletion in progress/);assert.equal(rentalStatus(4),'');
    competitor=await heldRace(rentSql(5,courts[1],720,780,quote(5,courts[1],720,780)),`select public.account_deletion_begin('${users[5]}')::text;`);
    assert.equal(competitor.code,0,'begin waits, then succeeds');assert.equal(JSON.parse(competitor.out).cancelled_rentals,1);assert.equal(rentalStatus(5),'cancelled');
    console.log('PASS: observed lock waits: deletion-first refuses the waiting rental (account_deleted, no inventory); rental-first commits and the waiting deletion cancels it.');
    // Real pg_cron: the retention schedule helper is idempotent, and a cron-run sweep clears a decided report's text after 180 days.
    if(!cronInstalled()){sql('create extension pg_cron;');cronCreated=true;}
    jobBefore=sql(`select coalesce((select jobid::text from cron.job where jobname='privacy-retention-sweep'),'')`);
    const jobId=sql('select private.privacy_retention_schedule();');scheduled=true;assert.equal(sql('select private.privacy_retention_schedule();'),jobId);
    assert.deepEqual(JSON.parse(sql(`select jsonb_build_object('jobname',jobname,'schedule',schedule,'command',command,'active',active,'username',username) from cron.job where jobid=${jobId}`)),
      {jobname:'privacy-retention-sweep',schedule:'17 19 * * *',command:'select private.privacy_retention_sweep(500)',active:true,username:'postgres'});
    const oldReport=sql(`insert into private.venue_reports(venue_id,reporter_user_id,request_id,reason,details,status,reviewed_at,created_at)
      values('${venue}','${users[2]}','${randomUUID()}','closed','Old local note','dismissed',clock_timestamp()-interval '181 days',clock_timestamp()-interval '190 days') returning id;`);
    const freshReport=sql(`insert into private.venue_reports(venue_id,reporter_user_id,request_id,reason,details,status,reviewed_at,created_at)
      values('${venue}','${users[2]}','${randomUUID()}','closed','Fresh local note','resolved',clock_timestamp()-interval '10 days',clock_timestamp()-interval '20 days') returning id;`);
    const since=sql('select clock_timestamp();');checkJob=sql("select cron.schedule('t47-retention-check','2 seconds','select private.privacy_retention_sweep(500)');");
    const details=id=>sql(`select coalesce(details,'<null>') from private.venue_reports where id='${id}'`);
    for(let n=0;n<100&&details(oldReport)!=='<null>';n++)await new Promise(r=>setTimeout(r,200));
    assert.equal(details(oldReport),'<null>','cron sweep cleared the old text');assert.equal(details(freshReport),'Fresh local note');
    assert.ok(Number(sql(`select count(*) from cron.job_run_details where jobid=${checkJob} and status='succeeded' and start_time>='${since}'`))>0,'Cron run succeeded');
    console.log(`PASS: pg_cron ${sql("select extversion from pg_extension where extname='pg_cron'")}: retention schedule helper is idempotent (one daily '17 19 * * *' UTC postgres job); a cron-run sweep cleared a 181-day-old decision's text and kept a recent one.`);
    // Serve the actual pinned Deno Edge runtime with Redis deliberately absent: deletion still completes, like cancellation.
    const envPath=path.join(temp,'functions.env');fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\n`);
    // A killed Windows `functions serve` leaves its container running; wait for a fresh one before trusting replies.
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    child=spawn(cli,['functions','serve','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const invoke=(token,init={})=>fetch(new URL('functions/v1/account-deletion',api).href,{method:'POST',...init,
      headers:{apikey:config.ANON_KEY,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...init.headers},signal:AbortSignal.timeout(20000)});
    let ready=false;for(let n=0;n<120;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{const current=edgeId();if(current&&current!==staleEdge&&(await invoke(null,{body:'{}'})).status===401){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,500));}
    assert.ok(ready,'Fresh Edge ready');
    assert.equal((await invoke(forged,{body:JSON.stringify({confirm:'delete_account'})})).status,401);
    assert.equal((await invoke(tokens[6],{method:'GET',body:undefined})).status,405);
    const served=await invoke(tokens[6],{body:JSON.stringify({confirm:'delete_account'})});assert.equal(served.status,200);assert.deepEqual(await served.json(),{status:'deleted'});
    assert.equal(await authUser(6),null);
    const again=await invoke(tokens[6],{body:JSON.stringify({confirm:'delete_account'})});assert.equal(again.status,200,'served retry confirmed');
    console.log('PASS: actual served Edge forged JWT 401, GET 405, deletion 200 with Redis absent (outage continues) and a confirmed retry.');
  }finally{
    if(child&&child.exitCode===null)child.kill();for(const worker of workers)worker.kill();let clean=true;const steps=[];
    if(checkJob)steps.push(()=>sql(`select cron.unschedule(${checkJob});delete from cron.job_run_details where jobid=${checkJob};`));
    if(cronCreated)steps.push(()=>sql('drop extension pg_cron;'));
    else if(scheduled&&jobBefore==='')steps.push(()=>sql(`delete from cron.job_run_details where jobid=(select jobid from cron.job where jobname='privacy-retention-sweep');
      select cron.unschedule('privacy-retention-sweep');`));
    if(created)steps.push(()=>sql(`delete from public.venues where id='${venue}';`));
    for(const id of users)steps.push(async()=>{const r=await service.auth.admin.deleteUser(id);assert.ok(!r.error||r.error.status===404,'Own account cleanup');});
    steps.push(()=>sql(`delete from private.directory_audit_events where target_venue_id='${venue}';delete from private.moderation_audit_events where target_venue_id='${venue}';
      delete from private.account_deletions where user_id in (${users.map(id=>`'${id}'`).join(',')||'null'});`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-deletion-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,anon,...clients])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own fixtures/accounts/objects/audits/deletion records/cron jobs/temp removed; pg_cron state and pre-existing IDs preserved; no hosted changes.');
}
main().catch(error=>{console.error(`Local deletion check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API, Storage and Edge setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;});
