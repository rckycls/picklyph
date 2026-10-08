// T46: real local Docker/Auth/PostgREST, the shipped report handler and mobile client, observed lock races and served Edge. No hosted/mobile env.
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
    'users',(select jsonb_agg(id order by id) from auth.users),'owners',(select jsonb_agg(venue_id::text||user_id::text order by venue_id,user_id) from private.venue_owners),
    'roles',(select jsonb_agg(user_id::text||role::text order by user_id,role) from private.account_roles),
    'reports',(select jsonb_agg(id order by id) from private.venue_reports),'markers',(select jsonb_agg(venue_id order by venue_id) from private.venue_moderation_suspensions),
    'moderation',(select jsonb_agg(id order by id) from private.moderation_audit_events),'audit',(select jsonb_agg(id order by id) from private.directory_audit_events),
    'allocations',(select jsonb_agg(id order by id) from private.court_allocations),'groups',(select jsonb_agg(id order by id) from private.session_bookings));`);
  const beforeInventory=inventory();
  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'moderation.sql'),'utf8'));
  console.log('PASS: Docker moderation SQL: reports, reviewer-only decisions, suspension vs every booking command, reinstatement limits, audited revocation, moderator denial matrix.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(r,message)=>{assert.ok(!r.error,message);return r.data;};const users=[],clients=[],tokens=[];const venue=randomUUID();
  const courts=[randomUUID(),randomUUID()].sort();let created=false;let child;const workers=new Set();const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-moderation-'));
  const dbSession=query=>new Promise(resolve=>{
    const worker=spawn(docker,args,{windowsHide:true});workers.add(worker);let out='',err='';
    worker.stdout.on('data',d=>out+=d);worker.stderr.on('data',d=>err+=d);
    worker.on('error',()=>resolve({code:-1,out,err}));worker.on('close',code=>{workers.delete(worker);resolve({code,out:out.trim(),err});});worker.stdin.end(query);
  });
  // The holder keeps its locks while sleeping; the competitor is started only once the holder is observed asleep.
  const heldRace=async(first,second)=>{
    const name=`pickly-moderation-${randomUUID()}`;
    const holder=dbSession(`set application_name='${name}';begin;${first}select pg_sleep(1.89);commit;`);
    let observed=false;
    for(let n=0;n<100&&!observed;n++){
      observed=sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event='PgSleep'`)==='1';
      if(!observed)await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(observed,'Observed holder locks');const competitor=await dbSession(second);const winner=await holder;assert.equal(winner.code,0,'Holder committed');return competitor;
  };
  const handlerModule=load(path.join(__dirname,'../functions/venue-reports/handler.ts'),{},{TextDecoder});
  const {createSupabaseReportDeps}=load(path.join(__dirname,'../functions/venue-reports/deps.ts'),{'./handler.ts':handlerModule});
  const root=path.resolve(__dirname,'../..');
  const domain={...require(path.join(root,'packages/domain/src/moderation.ts')),...require(path.join(root,'packages/domain/src/booking.ts'))};
  const mobile=load(path.join(root,'src/features/discovery/reportClient.ts'),{'@picklyph/domain':domain,'../owner/venueClient':require(path.join(root,'src/features/owner/venueClient.ts'))});
  const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();
  const status=()=>sql(`select publication_status::text||'/'||claim_status::text from public.venues where id='${venue}'`);
  const audits=()=>JSON.parse(sql(`select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from private.moderation_audit_events where target_venue_id='${venue}' group by action) x;`));
  const quote=(user,court,a,b)=>JSON.parse(sql(`select public.rental_booking_quote('${users[user]}','${court}','${at(a)}','${at(b)}')->'expected_quote';`));
  const rentSql=(user,court,a,b,expected,key=randomUUID())=>`select public.rental_booking_request('${users[user]}','${court}','${key}','${at(a)}','${at(b)}',${literal(expected)});`;
  const decideSql=(decision,reason=null)=>`select public.moderation_decide('${users[3]}','${venue}','${decision}',${reason?`'${reason}'`:'null'},'{}');`;
  try{
    // Accounts: 0 owner, 1-2 players, 3 moderator.
    for(let n=0;n<4;n++){
      const credentials={email:`moderation-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own account').user.id);
      const c=createClient(api.href,config.ANON_KEY,options);clients.push(c);tokens.push(check(await c.auth.signInWithPassword(credentials),'Own login').session.access_token);
    }
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Moderation Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);created=true;
    sql(`insert into public.courts(id,venue_id,name) values('${courts[0]}','${venue}','A'),('${courts[1]}','${venue}','B');
      insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');
      insert into private.account_roles(user_id,role) values('${users[3]}','moderator');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',0,'end_minute',1440,'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));`);
    const enforced=async()=>({allowed:true,status:200,state:'enforced',headers:{}});const server=()=>createClient(api.href,config.SERVICE_ROLE_KEY,options);
    const reports=handlerModule.createVenueReportHandler({...createSupabaseReportDeps(()=>anon,server),limit:enforced});
    const send=(user,body,token=tokens[user])=>reports(new Request('https://local.test',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)}));
    const report=(reason='closed',details=null,key=randomUUID())=>({request_id:key,venue_id:venue,reason,details});
    // Reports: six concurrent retries of one key make one report; competing keys from the same player are refused.
    const one=report('wrong_details','Hours on the gate differ');const retries=await Promise.all(Array.from({length:6},()=>send(1,one)));
    assert.ok(retries.every(r=>r.status===200));const retryBodies=await Promise.all(retries.map(r=>r.json()));
    assert.deepEqual(retryBodies.map(b=>b.outcome).sort(),['created',...Array(5).fill('existing')]);assert.equal(new Set(retryBodies.map(b=>b.report.id)).size,1);
    const competing=await Promise.all(['closed','unsafe','other'].map(reason=>send(1,report(reason))));
    assert.ok(competing.every(r=>r.status===409));assert.ok((await Promise.all(competing.map(r=>r.json()))).every(b=>b.error==='already_reported'));
    assert.equal(sql(`select count(*) from private.venue_reports where venue_id='${venue}'`),'1');assert.deepEqual(audits(),{'report.submit':1});
    const forged=`${tokens[1].split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[1],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await send(1,report(),forged)).status,401);assert.equal((await send(1,{...report(),actor_user_id:users[3]})).status,400);
    console.log('PASS: real API six retries of one report key record one report and one audit row; competing keys from the same player get already_reported; forged JWT 401, smuggled actor 400.');
    // The shipped mobile client: a lost reply after commit is retried with the same body and resolves to the original report.
    let loseReply=true;
    const transport={endpoint:'https://local.test',apiKey:config.ANON_KEY,accessToken:async()=>tokens[2],fetch:async(url,init)=>{
      const response=await reports(new Request(url,init));if(loseReply){loseReply=false;throw new Error('Lost reply after commit');}
      return {ok:response.ok,status:response.status,headers:response.headers,json:()=>response.json()};
    }};
    const draft=mobile.reportDraft({requestId:randomUUID(),venueId:venue,reason:'unsafe',details:'  Loose net post\r\nnear court B '});
    assert.equal((await mobile.submitReport(transport,draft)).failure.kind,'network');
    const recovered=await mobile.submitReport(transport,draft);assert.equal(recovered.ok,true);assert.equal(recovered.value.outcome,'existing');
    assert.equal(recovered.value.report.details,'Loose net post\nnear court B');
    assert.equal(sql(`select count(*) from private.venue_reports where reporter_user_id='${users[2]}'`),'1');
    console.log('PASS: shipped mobile report client recovers one lost committed reply as the original report (normalized details), one row.');
    // Concurrent conflicting decisions on the same reports: one kind wins, one audit row per report.
    const reportIds=sql(`select string_agg(id::text,',' order by id) from private.venue_reports where venue_id='${venue}'`).split(',');
    const decide=(decision,ids,reason=null)=>service.rpc('moderation_decide',{actor_user_id:users[3],target_venue_id:venue,decision,reason,report_ids:ids});
    const mixed=await Promise.all([...Array(4).fill('dismiss'),...Array(4).fill('resolve')].map(d=>decide(d,reportIds)));
    const winners=mixed.filter(r=>!r.error);const kinds=new Set(winners.map((r,i)=>r.data.item.reports[0].status));
    assert.equal(kinds.size,1);assert.equal(winners.filter(r=>r.data.outcome==='decided').length,1);
    assert.ok(mixed.every(r=>!r.error||r.error.hint==='already_decided'));const won=[...kinds][0];
    assert.deepEqual(audits(),{'report.submit':2,[won==='dismissed'?'report.dismiss':'report.resolve']:2});
    assert.equal((await service.rpc('moderation_decide',{actor_user_id:users[1],target_venue_id:venue,decision:'dismiss',reason:null,report_ids:reportIds})).error.hint,'moderator_required');
    assert.equal((await clients[3].rpc('moderation_queue',{actor_user_id:users[3]})).error?.code,'42501','moderators still go through the console server');
    console.log(`PASS: real API four dismissals and four resolutions race: one decision (${won}), one audit row per report; players and direct client calls are refused.`);
    // Six concurrent suspensions: one transition, one audit row, one directory row.
    const suspensions=await Promise.all(Array.from({length:6},()=>decide('suspend',[],'unsafe')));
    assert.ok(suspensions.every(r=>!r.error));assert.deepEqual(suspensions.map(r=>r.data.outcome).sort(),['decided',...Array(5).fill('existing')]);
    assert.equal(status(),'suspended/verified');assert.equal(audits()['venue.suspend'],1);
    assert.equal(sql(`select count(*) from private.directory_audit_events where target_venue_id='${venue}' and action='directory.suspend'`),'1');
    assert.equal((await anon.from('venues').select('id').eq('id',venue)).data.length,0,'off Discover');
    const reinstated=await Promise.all(Array.from({length:3},()=>decide('reinstate',[])));
    assert.deepEqual(reinstated.map(r=>r.data.outcome).sort(),['decided','existing','existing']);assert.equal(status(),'approved/verified');
    console.log('PASS: real API six suspensions make one transition and one audit row; the listing leaves Discover; three reinstatements publish once.');
    // Observed lock orders: a suspension holding the listing refuses a waiting rental or group request; a booking holding it completes and survives.
    const first=quote(1,courts[0],600,660);
    let competitor=await heldRace(decideSql('suspend','unsafe'),rentSql(1,courts[0],600,660,first));
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Venue unavailable/);
    assert.equal(sql(`select count(*) from private.court_allocations a join public.courts c on c.id=a.court_id where c.venue_id='${venue}'`),'0');
    sql(decideSql('reinstate'));
    competitor=await heldRace(rentSql(1,courts[0],600,660,quote(1,courts[0],600,660)),decideSql('suspend','closed'));
    assert.equal(competitor.code,0,'suspension waits, then succeeds');assert.equal(status(),'suspended/verified');
    assert.equal(sql(`select b.status from private.rental_bookings b join private.court_allocations a on a.id=b.id where a.court_id='${courts[0]}'`),'confirmed','earlier booking stays');
    sql(decideSql('reinstate'));
    const session=check(await service.rpc('owner_session_create',{actor_user_id:users[0],session_input:{venue_id:venue,request_id:randomUUID(),court_ids:[courts[1]],
      title:'Moderation play',starts_at:at(720),ends_at:at(840),capacity:8,group_limit:4,price_centavos:25000}}),'Own session').session.id;
    competitor=await heldRace(decideSql('suspend','unsafe'),`select public.session_booking_request('${users[2]}',${literal({session_id:session,request_id:randomUUID(),participants:['Ana'],expected_total_centavos:25000})});`);
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Venue unavailable/);assert.equal(sql(`select count(*) from private.session_bookings where session_id='${session}'`),'0');
    sql(decideSql('reinstate'));
    console.log('PASS: observed lock waits: suspension-first refuses a waiting rental and group request with no inventory; rental-first commits and the waiting suspension follows, keeping the booking.');
    // Revocation holding the listing refuses a waiting owner command; the last owner leaves the listing unclaimed.
    competitor=await heldRace(`select public.ownership_revoke('${users[3]}','${venue}','${users[0]}','ownership_ended');`,
      `select public.owner_session_create('${users[0]}',${literal({venue_id:venue,request_id:randomUUID(),court_ids:[courts[1]],title:'Late play',
        starts_at:at(900),ends_at:at(960),capacity:8,group_limit:4,price_centavos:25000})});`);
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Owner required|Venue-owner authorization required|Venue unavailable/);
    assert.equal(status(),'approved/unclaimed');assert.equal(audits()['owner.revoke'],1);
    assert.equal((await clients[0].rpc('my_account_access')).data[0].owned_venue_ids.length,0,'revocation visible without a token refresh');
    console.log('PASS: observed lock wait: revocation-first refuses the waiting owner session; the last owner removal unclaims the listing and is audited once.');
    // Serve the actual pinned Deno Edge runtime, with Redis deliberately absent: report creation fails closed.
    const envPath=path.join(temp,'functions.env');fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\n`);
    // A killed Windows `functions serve` leaves its container running; wait for a fresh one before trusting replies.
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    child=spawn(cli,['functions','serve','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const invoke=(token,init={})=>fetch(new URL('functions/v1/venue-reports',api).href,{method:'POST',...init,
      headers:{apikey:config.ANON_KEY,'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{}),...init.headers},signal:AbortSignal.timeout(20000)});
    let ready=false;for(let n=0;n<120;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{const current=edgeId();if(current&&current!==staleEdge&&(await invoke(null,{body:'{}'})).status===401){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,500));}
    assert.ok(ready,'Fresh Edge ready');
    sql(`insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');update public.venues set claim_status='verified' where id='${venue}';`);
    assert.equal((await invoke(forged,{body:JSON.stringify(report())})).status,401);
    assert.equal((await invoke(tokens[0],{method:'GET',body:undefined})).status,405);
    const before=sql(`select count(*) from private.venue_reports`);
    const stopped=await invoke(tokens[0],{body:JSON.stringify(report('duplicate'))});
    assert.equal(stopped.status,503);assert.equal(stopped.headers.get('retry-after'),'5');assert.equal(sql(`select count(*) from private.venue_reports`),before);
    console.log('PASS: actual served Edge forged JWT 401, GET 405, Redis-outage report 503 with Retry-After and no write.');
  }finally{
    if(child&&child.exitCode===null)child.kill();for(const worker of workers)worker.kill();let clean=true;const steps=[];
    if(created)steps.push(()=>sql(`delete from public.venues where id='${venue}';`));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own account cleanup'));
    steps.push(()=>sql(`delete from private.directory_audit_events where target_venue_id='${venue}';delete from private.moderation_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-moderation-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,anon,...clients])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own fixtures/accounts/audits/temp removed; pre-existing IDs preserved; no hosted changes.');
}
main().catch(error=>{console.error(`Local moderation check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;});
