// Local Docker/Auth/PostgREST with real concurrent connections. Never reads hosted/mobile env.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const {createClient}=require('@supabase/supabase-js');
const load=require('./load-ts.cjs');
async function main(){
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');
  const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
  const context=run(['context','show']).trim();
  const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const psqlArgs=['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'];
  const psql=sql=>run(psqlArgs,sql).trim();
  // A separate database session per call, so these genuinely run concurrently.
  const session=sql=>new Promise(resolve=>{
    const child=spawn(docker,psqlArgs,{windowsHide:true});let out='',err='';
    child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
    child.on('error',()=>resolve({code:-1,out,err}));child.on('close',code=>resolve({code,out:out.trim(),err}));child.stdin.end(sql);
  });
  run(['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1','-o','/dev/null'],fs.readFileSync(path.join(__dirname,'allocations.sql'),'utf8'));
  console.log('PASS: Docker allocation SQL: half-open overlap/adjacency, retries, hold expiry without a sweep, renew/release, permissions, revocation, audit and rollback; fixtures rolled back.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const guest=createClient(api.href,config.ANON_KEY,options);
  const check=(result,message)=>{assert.ok(!result.error,message);return result.data;};
  const {createAllocationCommands,AllocationRejected}=load(path.join(__dirname,'../functions/_shared/allocations.ts'));
  // Each command gets a fresh stateless service client, as the Edge handlers do.
  const commands=createAllocationCommands(()=>createClient(api.href,config.SERVICE_ROLE_KEY,options));
  const reason=promise=>promise.then(()=>'ok',error=>{assert.ok(error instanceof AllocationRejected,`unexpected ${error?.message}`);return error.reason;});
  const users=[],clients=[];const venue=randomUUID();const courts=[randomUUID(),randomUUID(),randomUUID()];let created=false;
  // Manila wall clock two days ahead, so every interval is in the future.
  const manilaDate=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);
  const at=minute=>new Date(Date.parse(`${manilaDate}T00:00:00+08:00`)+minute*60000).toISOString();
  const block=(court,a,b,request=randomUUID())=>({court_id:court,request_id:request,starts_at:at(a),ends_at:at(b)});
  const acquire=(court,a,b,hold,request)=>`select private.allocation_acquire('${court}','rental','${at(a)}','${at(b)}',${hold},'${users[1]}','${request}');`;
  try{
    for(let i=0;i<2;i++){
      const credentials={email:`allocation-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own user').user.id);
      const client=createClient(api.href,config.ANON_KEY,options);clients.push(client);check(await client.auth.signInWithPassword(credentials),'Own login');
    }
    psql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values ('${venue}','Local Allocation Fixture','Fixture','Fixture','Fixture',14.6,121,'approved','verified');`);created=true;
    psql(`insert into public.courts(id,venue_id,name) values ('${courts[0]}','${venue}','A'),('${courts[1]}','${venue}','B'),('${courts[2]}','${venue}','C');
      insert into private.venue_owners(user_id,venue_id) values ('${users[0]}','${venue}');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',360,'end_minute',1320,'rates',jsonb_build_array(jsonb_build_object('start_minute',360,'end_minute',1320,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));`);
    let blocks=0;
    // 1. Identical and pairwise-overlapping simultaneous requests: exactly one winner each.
    const same=await Promise.all(Array.from({length:8},()=>reason(commands.block(users[0],block(courts[0],600,660)))));
    assert.deepEqual([same.filter(r=>r==='ok').length,same.filter(r=>r==='allocation_conflict').length],[1,7]);blocks++;
    const windows=[[480,660],[540,660],[600,660],[600,720],[630,660],[630,780]];
    const mixed=await Promise.all(windows.map(([a,b])=>reason(commands.block(users[0],block(courts[1],a,b)))));
    assert.deepEqual([mixed.filter(r=>r==='ok').length,mixed.filter(r=>r==='allocation_conflict').length],[1,5]);blocks++;
    // 2. Adjacent half-open intervals on one court, and one interval on two courts, all succeed together.
    const adjacent=await Promise.all(Array.from({length:8},(_,k)=>reason(commands.block(users[0],block(courts[0],720+k*60,780+k*60)))));
    assert.ok(adjacent.every(r=>r==='ok'));blocks+=8;
    const across=await Promise.all([courts[1],courts[2]].map(court=>reason(commands.block(users[0],block(court,1200,1260)))));
    assert.deepEqual(across,['ok','ok']);blocks+=2;
    // 3. Simultaneous retries of one request create one allocation.
    const retry=block(courts[2],600,660);
    const replies=await Promise.all(Array.from({length:8},()=>commands.block(users[0],retry)));
    assert.equal(new Set(replies.map(r=>r.allocation.id)).size,1);
    assert.deepEqual(replies.map(r=>r.outcome).sort(),['created',...Array(7).fill('existing')]);blocks++;
    assert.equal(psql(`select count(*) from private.court_allocations where venue_id='${venue}' and request_id='${retry.request_id}'`),'1');
    assert.equal(psql(`select count(*) from private.court_allocations where venue_id='${venue}'`),String(blocks));
    console.log('PASS: real PostgREST concurrency: 8 identical and 6 overlapping requests yield one winner each; 8 adjacent and 2 cross-court succeed; 8 retries create one allocation.');
    // 4. A transaction holding the court lock: a competitor waits, then loses on commit and wins on rollback.
    const waits=async(finish,request)=>{
      const first=session(`begin; ${acquire(courts[2],720,780,'null',randomUUID())} select pg_sleep(3.01); ${finish};`);
      // Start the competitor only once the first session holds the lock and is sleeping.
      let holding=false;
      for(let n=0;n<100&&!holding;n++){holding=psql(`select count(*) from pg_stat_activity where state='active' and query like 'select pg_sleep(3.01)%'`)==='1';
        if(!holding)await new Promise(r=>setTimeout(r,100));}
      assert.ok(holding,'first session holds the court lock');
      const second=await session(`select extract(epoch from clock_timestamp()); ${acquire(courts[2],720,780,'null',request)} select extract(epoch from clock_timestamp());`);
      const winner=await first;assert.equal(winner.code,0,'first session acquired');assert.match(winner.out,/"outcome": "created"/);
      return second;
    };
    const lost=await waits('commit',randomUUID());
    assert.notEqual(lost.code,0);assert.match(lost.err,/Court already allocated/);
    const committed=psql(`select count(*) from private.court_allocations where court_id='${courts[2]}' and starts_at='${at(720)}'`);
    assert.equal(committed,'1');psql(`delete from private.court_allocations where court_id='${courts[2]}' and starts_at='${at(720)}';`);
    const won=await waits('rollback',randomUUID());
    assert.equal(won.code,0,'competitor acquires after rollback');
    const [t0,result,t1]=won.out.split('\n');assert.match(result,/"outcome": "created"/);
    assert.ok(Number(t1)-Number(t0)>0.5,'competitor waited for the court lock');
    assert.equal(psql(`select count(*) from private.court_allocations where court_id='${courts[2]}' and starts_at='${at(720)}' and state='active'`),'1');
    console.log('PASS: separate DB sessions: a competitor waits on the court lock, then conflicts after commit and acquires after rollback; nothing from the rolled-back transaction remains.');
    // 5. An elapsed hold stops consuming inventory with no sweep; concurrent acquirers still get one winner.
    const hold=randomUUID();
    psql(acquire(courts[1],840,900,`clock_timestamp()+interval '4 seconds'`,hold));
    assert.equal(await reason(commands.block(users[0],block(courts[1],840,900))),'allocation_conflict');
    const live=async()=>(await commands.read(users[0],venue,at(0),at(1440))).allocations
      .filter(a=>a.court_id===courts[1]&&Date.parse(a.starts_at)===Date.parse(at(840))).length;
    assert.equal(await live(),1);
    await new Promise(r=>setTimeout(r,4500));
    assert.equal(psql(`select state from private.court_allocations where request_id='${hold}'`),'active','no sweep ran');
    assert.equal(await live(),0,'read treats the elapsed hold as free');
    const after=await Promise.all(Array.from({length:6},()=>reason(commands.block(users[0],block(courts[1],840,900)))));
    assert.deepEqual([after.filter(r=>r==='ok').length,after.filter(r=>r==='allocation_conflict').length],[1,5]);blocks++;
    assert.equal(psql(`select state||','||(ended_at=expires_at) from private.court_allocations where request_id='${hold}'`),'expired,true');
    const revive=await session(acquire(courts[1],840,900,'null',hold));
    assert.equal(revive.code,0);assert.match(revive.out,/"state": "expired"/);
    console.log('PASS: hold expiry: live hold blocks, elapsed hold is free on read without any sweep, 6 concurrent acquirers yield one winner, the hold is marked expired and its retry is not revived.');
    // 6. Release, client bypass and revocation.
    const target=(await commands.read(users[0],venue,at(0),at(1440))).allocations.find(a=>a.court_id===courts[0]&&a.kind==='block');
    assert.equal((await commands.release(users[0],target.id)).outcome,'released');
    assert.equal((await commands.release(users[0],target.id)).outcome,'existing');
    assert.equal(await reason(commands.release(users[1],target.id)),'not_owner');
    for(const client of [clients[0],guest]){
      assert.equal((await client.rpc('court_allocation_block',{actor_user_id:users[0],target_court_id:courts[0],block_request_id:randomUUID(),
        block_starts_at:at(1260),block_ends_at:at(1320)})).error?.code,'42501');
      assert.equal((await client.rpc('court_allocation_read',{actor_user_id:users[0],target_venue_id:venue,range_start:at(0),range_end:at(1440)})).error?.code,'42501');
      assert.ok((await client.schema('private').from('court_allocations').select('id')).error,'private schema not exposed');
      assert.ok((await client.rpc('allocation_acquire',{})).error,'primitive not exposed');
    }
    assert.equal(await reason(commands.block(users[1],block(courts[0],1260,1320))),'not_owner');
    psql(`delete from private.venue_owners where venue_id='${venue}';`);
    assert.equal(await reason(commands.block(users[0],block(courts[0],1260,1320))),'not_owner');
    assert.equal(await reason(commands.read(users[0],venue,at(0),at(1440))),'not_owner');
    assert.equal(psql(`select count(*) from private.court_allocations where venue_id='${venue}' and starts_at='${at(1260)}'`),'0');
    assert.equal(psql(`select count(*) filter (where action='allocation.block')||','||count(*) filter (where action='allocation.release')||','||bool_and(actor_user_id='${users[0]}'::uuid)
      from private.directory_audit_events where target_venue_id='${venue}' and action like 'allocation.%'`),`${blocks},1,true`);
    console.log(`PASS: owner release is idempotent; authenticated/guest RPC and private-table access denied; other user and revoked owner refused; ${blocks} block audits and 1 release audit, all by the owner.`);
  }finally{
    let clean=true;const steps=[];
    if(created)steps.push(()=>psql(`delete from public.venues where id='${venue}';`));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own user cleanup'));
    steps.push(()=>psql(`delete from private.directory_audit_events where target_venue_id='${venue}';`));
    for(const client of [service,guest,...clients])steps.push(()=>client.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures removed');
    assert.equal(psql(`select (select count(*) from private.court_allocations where venue_id='${venue}')+(select count(*) from public.courts where venue_id='${venue}')
      +(select count(*) from private.venue_schedules where venue_id='${venue}')+(select count(*) from private.directory_audit_events where target_venue_id='${venue}')`),'0');
  }
  console.log('PASS: own fixtures, allocations, schedule, audit rows and accounts removed; no hosted changes.');
}
main().catch(error=>{console.error(`Local allocation check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations and API setup.'}`);process.exitCode=1;});
