// T51b: real local Docker/Auth/Storage, the served storage-sweep function, and real pg_cron + pg_net calling it. Files are
// uploaded through the real Storage API (avatars by their owner's own client); trusted SQL backdates decisions and object ages
// to stand in for time passing. The sweep must remove exactly what is due and nothing else. No hosted or mobile env.
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {randomUUID,randomBytes}=require('node:crypto');const {execFileSync,spawn}=require('node:child_process');const {createClient}=require('@supabase/supabase-js');
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
  if(cronAtStart)assert.equal(sql(`select count(*) from cron.job where jobname='storage-sweep'`),'0','Run on a database without the storage-sweep job');
  assert.equal(sql(`select count(*) from vault.secrets where name in ('storage_sweep_url','storage_sweep_secret')`),'0','Run on a database without storage sweep Vault secrets');
  assert.equal(sql('select count(*) from private.storage_sweep_candidates(clock_timestamp())'),'0','Run on a database with nothing due for the storage sweep');
  const inventory=()=>sql(`select jsonb_build_object('users',(select jsonb_agg(id order by id) from auth.users),'venues',(select jsonb_agg(id order by id) from public.venues),
    'objects',(select jsonb_agg(bucket_id||'/'||name order by bucket_id,name) from storage.objects),'claims',(select jsonb_agg(id order by id) from private.venue_claims),
    'submissions',(select jsonb_agg(id order by id) from private.venue_submissions),'purged',(select count(*) from private.venue_claims where evidence_purged_at is not null),
    'signals',(select jsonb_agg(to_jsonb(s) order by minute,source,kind) from private.ops_signals s),
    'vault',(select jsonb_agg(name order by name) from vault.secrets),'extensions',(select jsonb_agg(extname order by extname) from pg_extension));`);
  const beforeInventory=inventory();const before=JSON.parse(beforeInventory);
  const literal=value=>`'${JSON.stringify(value??[]).replace(/'/g,"''")}'::jsonb`;

  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'storage-sweep.sql'),'utf8'));
  console.log('PASS: Docker storage-sweep SQL: grants, due items (evidence 30 days after a decision, unreferenced objects after 24 hours, three buckets only), confirmation records each purge once and only once the object is gone, reviewer reads, storage.backlog.');

  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const check=(r,message)=>{assert.ok(!r.error,`${message}: ${r.error?.message??''}`);return r.data;};
  const users=[],tokens=[],clients=[];const venue=randomUUID();const uploads=[];
  let created=false,child,cronCreated=false,netCreated=false,vaultCreated=false;const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-sweep-'));
  const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0,16,0x4a,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0,0xff,0xd9]);
  const upload=async(client,bucket,name)=>{check(await client.storage.from(bucket).upload(name,jpeg,{contentType:'image/jpeg'}),`Own ${bucket} upload`);uploads.push([bucket,name]);return name;};
  const exists=(bucket,name)=>sql(`select count(*) from storage.objects where bucket_id='${bucket}' and name='${name}'`)==='1';
  // Storage itself, not just its table: a removed object can no longer be downloaded.
  const downloadable=async(bucket,name)=>!(await service.storage.from(bucket).download(name)).error;
  const age=(bucket,name,interval)=>sql(`update storage.objects set created_at=clock_timestamp()-interval '${interval}' where bucket_id='${bucket}' and name='${name}';`);
  const waitFor=async(predicate,label,timeout=150000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(1000);}assert.fail(`Timed out waiting for ${label}`);};
  try{
    // Accounts: 0 claimant/submitter, 1 player with avatars, 2 admin reviewer.
    for(let n=0;n<3;n++){
      const credentials={email:`sweep-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own account').user.id);
      const c=createClient(api.href,config.ANON_KEY,options);clients.push(c);tokens.push(check(await c.auth.signInWithPassword(credentials),'Own login').session.access_token);
    }
    sql(`insert into private.account_roles(user_id,role) values('${users[2]}','admin');
      insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Sweep Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);created=true;
    const ev=()=>`${users[0]}/${randomUUID()}.jpg`;
    // Evidence: A decided 32 days ago (due), B decided 29 days ago (kept), E a submission rejected 31 days ago (due),
    // an uncertain upload 25 hours old (due) and one 23 hours old (kept).
    const [eA,eB,eE,eOld,eNew]=[await upload(service,'owner-evidence',ev()),await upload(service,'owner-evidence',ev()),await upload(service,'owner-evidence',ev()),
      await upload(service,'owner-evidence',ev()),await upload(service,'owner-evidence',ev())];
    const claim=(evidence,status,days)=>sql(`insert into private.venue_claims(venue_id,claimant_user_id,evidence_path,status,reviewed_by,reviewed_at,review_reason)
      values('${venue}','${users[0]}','${evidence}','${status}','${users[2]}',clock_timestamp()-interval '${days} days',${status==='rejected'?"'not_owner'":'null'}) returning id;`);
    const claimA=claim(eA,'approved',32);const claimB=claim(eB,'rejected',29);
    const submissionE=sql(`insert into private.venue_submissions(submitter_user_id,request_id,name,address_line,city,province,latitude,longitude,court_count,
      evidence_path,duplicates_acknowledged,status,reviewed_by,reviewed_at,review_reason) values('${users[0]}','${randomUUID()}','Local Sweep Proposed','Fixture','Manila',
      'Metro Manila',14.61,121.01,2,'${eE}',false,'rejected','${users[2]}',clock_timestamp()-interval '31 days','not_a_venue') returning id;`);
    for(const name of [eA,eB,eE])age('owner-evidence',name,'33 days');
    age('owner-evidence',eOld,'25 hours');age('owner-evidence',eNew,'23 hours');
    // Listing photos: one on the listing (kept), one whose cleanup failed 30 hours ago (due).
    const [pKept,pOrphan]=[await upload(service,'venue-photos',`${venue}/${randomUUID()}.jpg`),await upload(service,'venue-photos',`${venue}/${randomUUID()}.jpg`)];
    sql(`insert into public.venue_photos(venue_id,storage_path,width,height) values('${venue}','${pKept}',800,600);`);
    age('venue-photos',pKept,'3 days');age('venue-photos',pOrphan,'30 hours');
    // Avatars through the player's own client: the current one (kept) and a replaced one left behind 30 hours ago (due).
    const [aKept,aOld]=[await upload(clients[1],'avatars',`${users[1]}/${randomUUID()}.jpg`),await upload(clients[1],'avatars',`${users[1]}/${randomUUID()}.jpg`)];
    check(await clients[1].from('profiles').update({avatar_path:aKept}).eq('id',users[1]),'Own profile photo');
    age('avatars',aKept,'3 days');age('avatars',aOld,'30 hours');
    const due=JSON.parse(sql(`select public.storage_sweep_due(1000)::text`));
    assert.deepEqual(due.items.map(i=>`${i.bucket}/${i.path}/${i.reason}`).sort(),[`owner-evidence/${eA}/evidence_retention`,`owner-evidence/${eE}/evidence_retention`,
      `owner-evidence/${eOld}/unreferenced`,`venue-photos/${pOrphan}/unreferenced`,`avatars/${aOld}/unreferenced`].sort());
    const removed=[['owner-evidence',eA],['owner-evidence',eE],['owner-evidence',eOld],['venue-photos',pOrphan],['avatars',aOld]];
    const kept=[['owner-evidence',eB],['owner-evidence',eNew],['venue-photos',pKept],['avatars',aKept]];
    console.log('PASS: real Storage fixtures: 5 of 9 uploads due (2 decided proofs, an uncertain upload, a stranded listing photo, a replaced avatar).');

    // Serve the pinned Edge runtime with the worker secret.
    const secret=randomBytes(32).toString('base64url');const envPath=path.join(temp,'functions.env');
    fs.writeFileSync(envPath,[`DISCOVERY_SUPABASE_URL=http://kong:8000`,`DISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}`,`DISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}`,
      'PICKLY_ENV=local',`STORAGE_SWEEP_SECRET=${secret}`,''].join('\n'));
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    child=spawn(cli,['functions','serve','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const invoke=(auth,init={})=>fetch(new URL('functions/v1/storage-sweep',api).href,{method:'POST',body:'{}',...init,
      headers:{apikey:config.ANON_KEY,'content-type':'application/json',...(auth?{authorization:`Bearer ${auth}`}:{}),...init.headers},signal:AbortSignal.timeout(60000)});
    let ready=false;for(let n=0;n<120;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{const current=edgeId();if(current&&current!==staleEdge&&(await invoke(null)).status===401){ready=true;break;}}catch{}
      await sleep(500);}
    assert.ok(ready,'Fresh Edge ready');
    assert.equal((await invoke(secret,{method:'GET',body:undefined})).status,405);
    assert.equal((await invoke(tokens[1])).status,401,'a user token is refused');
    assert.equal((await invoke(config.SERVICE_ROLE_KEY)).status,401,'the service key is not the worker secret');
    assert.equal((await invoke(randomBytes(32).toString('base64url'))).status,401,'a wrong secret is refused');
    for(const [bucket,name] of [...removed,...kept])assert.ok(exists(bucket,name),'nothing removed by refused calls');
    console.log('PASS: served storage-sweep: GET 405; a user token, the service key and a wrong secret 401; nothing removed.');

    // Two overlapping runs: the same end state, each purge recorded once.
    const replies=await Promise.all([invoke(secret),invoke(secret)]);
    for(const reply of replies)assert.equal(reply.status,200,'both runs succeed');
    const bodies=await Promise.all(replies.map(r=>r.json()));
    assert.equal(bodies.reduce((n,b)=>n+b.purged,0),2,'two purges recorded once between both runs');
    for(const [bucket,name] of removed){assert.ok(!exists(bucket,name),`${bucket} removed`);assert.ok(!(await downloadable(bucket,name)),`${bucket} gone from Storage`);}
    for(const [bucket,name] of kept){assert.ok(exists(bucket,name),`${bucket} kept`);assert.ok(await downloadable(bucket,name),`${bucket} still served`);}
    assert.equal(sql(`select string_agg(case when evidence_purged_at is null then 'kept' else 'purged' end,',' order by reviewed_at) from private.venue_claims where id in ('${claimA}','${claimB}')`),'purged,kept');
    assert.equal(sql(`select evidence_purged_at is not null from private.venue_submissions where id='${submissionE}'`),'t');
    const third=await invoke(secret);assert.equal(third.status,200);
    assert.deepEqual(await third.json(),{due:0,removed:0,purged:0,remaining:0,refused:0,rounds:1,more:false},'a later run finds nothing');
    // Reviewers: removed, not missing.
    const read=check(await service.rpc('ownership_review_read',{actor_user_id:users[2],subject_id:claimA}),'Reviewer read');
    assert.ok(Date.parse(read.evidence_removed_at)>Date.now()-120000,'the read carries the purge time');
    const evidence=await service.rpc('ownership_review_evidence',{actor_user_id:users[2],subject_id:claimA});
    assert.equal(evidence.error?.hint,'evidence_removed');
    assert.equal(check(await service.rpc('ownership_review_evidence',{actor_user_id:users[2],subject_id:claimB}),'Kept evidence'),eB);
    console.log(`PASS: two overlapping served runs (200, ${bodies.map(b=>b.removed).join(' + ')} removed) left exactly the 5 due objects gone from Storage and the 4 others served; claim A and submission E purged once, claim B kept; a third run found nothing; the reviewer read says removed (evidence_removed), claim B still streams.`);

    // pg_net, Vault and pg_cron: the real path.
    assert.match(String((()=>{try{sql('select private.storage_sweep_kick();');return 'ran';}catch(e){return e.stderr;}})()),/Storage sweep is not configured/);
    if(!netAtStart){sql('create extension pg_net;');netCreated=true;}
    if(!cronAtStart){sql('create extension pg_cron;');cronCreated=true;}
    sql(`select vault.create_secret('http://kong:8000/functions/v1/storage-sweep','storage_sweep_url');select vault.create_secret('${secret}','storage_sweep_secret');`);vaultCreated=true;
    const jobId=sql('select private.storage_sweep_schedule();');assert.equal(sql('select private.storage_sweep_schedule();'),jobId,'idempotent');
    assert.equal(sql(`select schedule||' | '||command from cron.job where jobid=${jobId}`),'47 19 * * * | select private.storage_sweep_kick()');
    // New work for the scheduled run: a decision 40 days old and another replaced avatar.
    const eLate=await upload(service,'owner-evidence',ev());const claimLate=claim(eLate,'approved',40);age('owner-evidence',eLate,'41 days');
    const aLate=await upload(clients[1],'avatars',`${users[1]}/${randomUUID()}.jpg`);age('avatars',aLate,'50 hours');
    assert.equal(sql(`select c->>'status'||':'||(c->>'count') from jsonb_array_elements(private.ops_health(clock_timestamp())) c where c->>'check'='storage.backlog'`),'warn:2',
      'both are over a day late for the monitor');
    // Faster for this run only: the same job every 20 seconds.
    sql(`select cron.schedule('storage-sweep','20 seconds','select private.storage_sweep_kick()');`);
    await waitFor(()=>!exists('owner-evidence',eLate)&&!exists('avatars',aLate)&&sql(`select evidence_purged_at is not null from private.venue_claims where id='${claimLate}'`)==='t',
      'the scheduled run to sweep');
    assert.ok(Number(sql(`select count(*) from net._http_response where status_code=200 and content like '%"purged":1%'`))>=1,'pg_net got the served sweep reply');
    assert.ok(Number(sql(`select count(*) from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='storage-sweep' and d.status='succeeded'`))>=1);
    assert.equal(sql(`select c->>'status' from jsonb_array_elements(private.ops_health(clock_timestamp())) c where c->>'check'='storage.backlog'`),'ok');
    for(const [bucket,name] of kept)assert.ok(exists(bucket,name),`${bucket} still kept`);
    console.log('PASS: kick refuses without Vault (not_configured); pg_cron (storage-sweep 47 19 * * *, run every 20 s here) → private.storage_sweep_kick → pg_net with Vault URL/secret → served storage-sweep removed a 40-day-old proof and a replaced avatar (storage.backlog warn:2 → ok); kept files untouched.');
  }finally{
    if(child&&child.exitCode===null)child.kill();let clean=true;const steps=[];
    if(cronAtStart)steps.push(()=>sql(`select cron.unschedule(jobname) from cron.job where jobname='storage-sweep';`));
    if(cronCreated)steps.push(()=>sql('drop extension pg_cron;'));
    if(netCreated)steps.push(()=>sql('drop extension pg_net;'));
    if(vaultCreated)steps.push(()=>sql(`delete from vault.secrets where name in ('storage_sweep_url','storage_sweep_secret');`));
    // Own uploads still present go through the Storage API, like the sweep.
    for(const bucket of ['owner-evidence','venue-photos','avatars'])steps.push(async()=>{
      const names=uploads.filter(u=>u[0]===bucket&&exists(bucket,u[1])).map(u=>u[1]);if(names.length)check(await service.storage.from(bucket).remove(names),'Own object cleanup');});
    if(created)steps.push(()=>sql(`delete from public.venues where id='${venue}';delete from private.directory_audit_events where target_venue_id='${venue}';`));
    if(users[2])steps.push(()=>sql(`delete from private.account_roles where user_id='${users[2]}';`));
    for(const id of users)steps.push(async()=>{const r=await service.auth.admin.deleteUser(id);assert.ok(!r.error||r.error.status===404,'Own account cleanup');});
    steps.push(()=>sql(`delete from private.ops_signals s where not exists (select 1 from jsonb_populate_recordset(null::private.ops_signals,${literal(before.signals)}) o
      where o.minute=s.minute and o.source=s.source and o.kind=s.kind);`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-sweep-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,...clients])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own fixtures/accounts/objects/Vault secrets/cron job/extensions/temp removed; pre-existing IDs preserved; no hosted changes.');
}
main().catch(error=>{console.error(`Local storage sweep check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API, Storage and Edge setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;});
