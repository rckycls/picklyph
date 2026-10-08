// T32: local Docker only. Rollback-only SQL, committed fixtures raced from independent psql sessions, then a real pg_cron run.
// The sweep has no API surface, so fixtures and commands go through trusted SQL. Restores the prior pg_cron state.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {randomUUID}=require('node:crypto');const {execFileSync,spawn}=require('node:child_process');
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
  const inventory=()=>sql(`select jsonb_build_object('venues',(select jsonb_agg(id order by id) from public.venues),
    'users',(select jsonb_agg(id order by id) from auth.users),'allocations',(select jsonb_agg(id order by id) from private.court_allocations),
    'rentals',(select jsonb_agg(id order by id) from private.rental_bookings),'rental_events',(select jsonb_agg(id order by id) from private.rental_events),
    'sessions',(select jsonb_agg(id order by id) from private.open_play_sessions),'groups',(select jsonb_agg(id order by id) from private.session_bookings),
    'group_events',(select jsonb_agg(id order by id) from private.session_booking_events),'audit',(select jsonb_agg(id order by id) from private.directory_audit_events),
    'ownership_audit',(select jsonb_agg(id order by id) from private.ownership_audit_events));`)+cronJobs();
  const beforeInventory=inventory();
  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'hold-expiry.sql'),'utf8'));
  console.log('PASS: Docker hold-sweep SQL: API roles denied; bounded oldest-first batches; delayed, acquisition-marked and command-expired holds record one expiry; commands after a sweep refuse without reviving; resale once; event checks; per-item failure rollback.');
  const users=Array.from({length:6},()=>randomUUID());const venue=randomUUID();const courts=[randomUUID(),randomUUID(),randomUUID()].sort();
  let usersCreated=false,venueCreated=false,cronCreated=false,scheduled=false,checkJob=null,jobBefore=null;const workers=new Set();
  const dbSession=query=>new Promise(resolve=>{
    const worker=spawn(docker,args,{windowsHide:true});workers.add(worker);let out='',err='';
    worker.stdout.on('data',d=>out+=d);worker.stderr.on('data',d=>err+=d);
    worker.on('error',()=>resolve({code:-1,out,err}));worker.on('close',code=>{workers.delete(worker);resolve({code,out:out.trim(),err});});worker.stdin.end(query);
  });
  const until=async(test,message,tries=150)=>{for(let n=0;n<tries;n++){if(test())return;await new Promise(r=>setTimeout(r,30));}assert.fail(message);};
  const activity=name=>sql(`select coalesce(string_agg(coalesce(wait_event_type,'')||':'||coalesce(wait_event,''),','),'') from pg_stat_activity where application_name='${name}'`);
  // The holder keeps its locks while it sleeps. A waiting competitor is observed blocked on a lock; a skipping one finishes while the holder still sleeps.
  const race=async(first,second,competitorWaits)=>{
    const holderName=`pickly-sweep-${randomUUID()}`,competitorName=`pickly-sweep-${randomUUID()}`;let holderDone=false;
    const holder=dbSession(`set application_name='${holderName}';begin;${first}select pg_sleep(2.5);commit;`).then(r=>{holderDone=true;return r;});
    await until(()=>activity(holderName).endsWith(':PgSleep'),'Observed holder locks');
    const competitor=dbSession(`set application_name='${competitorName}';${second}`);
    if(competitorWaits)await until(()=>activity(competitorName).startsWith('Lock:'),'Observed competitor lock wait');
    else{await competitor;assert.ok(!holderDone,'Competitor finished without waiting');}
    const [h,c]=await Promise.all([holder,competitor]);assert.equal(h.code,0,'Holder committed');
    return {holder:JSON.parse(h.out.split('\n')[0]),competitor:c};
  };
  const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();
  const rentSql=(player,court,a,b,key=randomUUID())=>`select public.rental_booking_request('${users[player]}','${court}','${key}','${at(a)}','${at(b)}',
    public.rental_booking_quote('${users[player]}','${court}','${at(a)}','${at(b)}')->'expected_quote');`;
  const rent=(player,court,a,b)=>{const original=rentSql(player,court,a,b);const r=JSON.parse(sql(original));assert.equal(r.booking.status,'pending');return {id:r.booking.id,original};};
  const session=(a,b,capacity)=>JSON.parse(sql(`select public.owner_session_create('${users[0]}',jsonb_build_object('venue_id','${venue}','request_id','${randomUUID()}',
    'court_ids',jsonb_build_array('${courts[2]}'),'title','Local sweep play','starts_at','${at(a)}','ends_at','${at(b)}','capacity',${capacity},'group_limit',4,'price_centavos',25000));`)).session.id;
  const join=(player,target,n)=>{const r=JSON.parse(sql(`select public.session_booking_request('${users[player]}',jsonb_build_object('session_id','${target}','request_id','${randomUUID()}',
    'participants',(select jsonb_agg('Player '||g) from generate_series(1,${n}) g),'expected_total_centavos',${25000*n}));`));assert.equal(r.booking.status,'pending');return r.booking.id;};
  const ids=list=>`array[${list.map(id=>`'${id}'`).join(',')}]::uuid[]`;
  // Trusted SQL stands in for time passing until holds elapse.
  const elapseRentals=list=>sql(`update private.court_allocations set expires_at=clock_timestamp()-interval '1 second' where id=any(${ids(list)});`);
  const elapseGroups=list=>sql(`begin;alter table private.session_bookings disable trigger session_booking_guard;
    update private.session_bookings set expires_at=clock_timestamp()-interval '1 second' where id=any(${ids(list)});
    alter table private.session_bookings enable trigger session_booking_guard;commit;`);
  const sweepSql=n=>`select private.booking_expiry_sweep(${n});`;
  const rentalChange=(actor,id,command)=>`select public.rental_booking_change('${users[actor]}','${id}','${command}');`;
  const groupChange=(actor,id,command)=>`select public.session_booking_change('${users[actor]}','${id}','${command}');`;
  const refused=async(query,pattern=/cannot change/)=>{const r=await dbSession(query);assert.notEqual(r.code,0);assert.match(r.err,pattern);};
  const events=id=>JSON.parse(sql(`select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from (select action from private.rental_events where booking_id='${id}'
    union all select action from private.session_booking_events where booking_id='${id}') e group by action) x;`));
  const expiredBy=id=>sql(`select coalesce(actor_user_id::text,'system') from private.rental_events where booking_id='${id}' and action='expire'
    union all select coalesce(actor_user_id::text,'system') from private.session_booking_events where booking_id='${id}' and action='expire';`);
  const stored=id=>sql(`select coalesce((select status from private.rental_bookings where id='${id}'),(select status from private.session_bookings where id='${id}'));`);
  const swept=(list,actor='system')=>{for(const id of list){assert.deepEqual(events(id),{request:1,expire:1});assert.equal(expiredBy(id),actor);assert.equal(stored(id),'expired');}};
  const ended=list=>assert.equal(sql(`select count(*) from private.court_allocations where id=any(${ids(list)}) and (state<>'expired' or ended_at<>expires_at)`),'0','Allocations end at expiry');
  const invariant=()=>assert.equal(sql(`select count(*) from private.open_play_sessions s where s.venue_id='${venue}' and s.reserved_spots<>coalesce((select sum(b.spots)
    from private.session_bookings b where b.session_id=s.id and b.status in ('pending','confirmed')),0)`),'0','Counter equals live spots');
  const quiet={rentals:0,groups:0,skipped:0,failed:0,more:false};
  try{
    sql(`insert into auth.users(id,aud,role,email) select u,'authenticated','authenticated','sweep-'||u||'@example.test' from unnest(${ids(users)}) u;`);usersCreated=true;
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Sweep Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);venueCreated=true;
    sql(`insert into public.courts(id,venue_id,name) values('${courts[0]}','${venue}','A'),('${courts[1]}','${venue}','B'),('${courts[2]}','${venue}','C');
      insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',0,'end_minute',1440,'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));
      select public.owner_venue_policy_save('${users[0]}','${venue}',(select private.venue_policy_view('${venue}')->>'revision'),'{"confirmation":"approval","payment":"arrival"}');`);

    // 1. Overlapping sweeps over a backlog: 18 rental holds on two courts and 10 group holds in two sessions.
    const backlog=[];for(let k=0;k<9;k++)for(const c of [0,1])backlog.push(rent(1+backlog.length%5,courts[c],60*k,60*k+60).id);
    const s1=session(600,720,20),s2=session(780,840,20);const groups=[1,2,3,4,5].flatMap(p=>[join(p,s1,2),join(p,s2,1)]);
    elapseRentals(backlog);elapseGroups(groups);
    assert.equal(JSON.parse(sql(`select public.rental_booking_read('${users[1]}','${backlog[0]}')`)).booking.status,'expired');
    assert.equal(stored(backlog[0]),'pending');
    const results=(await Promise.all(Array.from({length:4},()=>dbSession(sweepSql(100))))).map(r=>{assert.equal(r.code,0,r.err);return JSON.parse(r.out);});
    assert.deepEqual(JSON.parse(sql(sweepSql(100))),quiet);
    const total=key=>results.reduce((n,r)=>n+r[key],0);
    assert.equal(total('rentals'),18);assert.equal(total('groups'),10);assert.equal(total('failed'),0);
    swept([...backlog,...groups]);ended(backlog);invariant();
    assert.equal(sql(`select sum(reserved_spots) from private.open_play_sessions where venue_id='${venue}'`),'0');
    console.log(`PASS: 4 overlapping sweeps (${results.map(r=>`${r.rentals}r+${r.groups}g/${r.skipped} skipped`).join(', ')}) expire 18 rentals and 10 groups exactly once; allocations end at expiry; counters 0; repeat sweep no-op.`);

    // 2. A sweep holding its locks makes a concurrent sweep skip, never wait or double-release.
    const s3=session(900,960,8);const pair=[rent(1,courts[0],600,660).id,rent(2,courts[1],600,660).id];const pairGroup=join(1,s3,2);
    elapseRentals(pair);elapseGroups([pairGroup]);
    const overlap=await race(sweepSql(100),sweepSql(100),false);
    assert.deepEqual(overlap.holder,{...quiet,rentals:2,groups:1});assert.deepEqual(JSON.parse(overlap.competitor.out),{...quiet,skipped:3});
    swept([...pair,pairGroup]);invariant();assert.deepEqual(JSON.parse(sql(sweepSql(100))),quiet);
    console.log('PASS: a held sweep makes a concurrent sweep skip all 3 locked items without waiting; one expiry each.');

    // 3. Declines and cancellations racing the sweep, in both lock orders, for rentals and groups.
    const commandFirst=async(hold,command,expiredActor)=>{
      const r=await race(command,sweepSql(100),false);
      assert.equal(r.holder.outcome,'expired');assert.deepEqual(JSON.parse(r.competitor.out),{...quiet,skipped:1});
      swept([hold],expiredActor);await refused(command);swept([hold],expiredActor);
    };
    const sweepFirst=async(hold,command,expected)=>{
      const r=await race(sweepSql(100),command,true);
      assert.deepEqual(r.holder,{...quiet,...expected});assert.notEqual(r.competitor.code,0);assert.match(r.competitor.err,/cannot change/);
      swept([hold]);await refused(command);swept([hold]);
    };
    const r1=rent(3,courts[0],660,720);elapseRentals([r1.id]);await commandFirst(r1.id,rentalChange(0,r1.id,'decline'),users[0]);
    const r2=rent(4,courts[0],720,780);elapseRentals([r2.id]);await sweepFirst(r2.id,rentalChange(0,r2.id,'decline'),{rentals:1});
    const r3=rent(5,courts[1],660,720);elapseRentals([r3.id]);await commandFirst(r3.id,rentalChange(5,r3.id,'cancel'),users[5]);
    const r4=rent(1,courts[1],720,780);elapseRentals([r4.id]);await sweepFirst(r4.id,rentalChange(1,r4.id,'cancel'),{rentals:1});
    // A group command that meets an elapsed hold releases it as a system expiry, like the sweep.
    const g1=join(2,s3,1);elapseGroups([g1]);await commandFirst(g1,groupChange(0,g1,'decline'),'system');
    const g2=join(3,s3,1);elapseGroups([g2]);await sweepFirst(g2,groupChange(0,g2,'decline'),{groups:1});
    const g3=join(4,s3,1);elapseGroups([g3]);await commandFirst(g3,groupChange(4,g3,'cancel'),'system');
    const g4=join(5,s3,1);elapseGroups([g4]);await sweepFirst(g4,groupChange(5,g4,'cancel'),{groups:1});
    invariant();assert.equal(sql(`select reserved_spots from private.open_play_sessions where id='${s3}'`),'0');
    assert.deepEqual(JSON.parse(sql(sweepSql(100))),quiet);
    console.log('PASS: owner decline and player cancel vs sweep in both lock orders, rentals and groups: command-first expires once while the sweep skips; sweep-first makes the command wait, then refuse; retries refuse with no new event.');

    // 4. Swept inventory resells once; the original retry never revives.
    const retried=JSON.parse(sql(r2.original));assert.equal(retried.outcome,'existing');assert.equal(retried.booking.status,'expired');
    assert.equal(JSON.parse(sql(rentSql(2,courts[0],720,780))).outcome,'created');await refused(rentSql(3,courts[0],720,780),/already allocated/);
    assert.deepEqual(events(r2.id),{request:1,expire:1});
    console.log('PASS: swept inventory resells to exactly one new rental; the original request retry stays expired with its snapshot.');

    // 5. Real pg_cron: the schedule helper is idempotent, and a cron-run sweep records the system expiry.
    if(!cronInstalled()){sql('create extension pg_cron;');cronCreated=true;}
    jobBefore=sql(`select coalesce((select jsonb_build_object('jobid',jobid,'schedule',schedule,'command',command,'active',active)::text
      from cron.job where jobname='booking-expiry-sweep'),'')`);
    const jobId=sql('select private.booking_expiry_schedule();');scheduled=true;assert.equal(sql('select private.booking_expiry_schedule();'),jobId);
    assert.deepEqual(JSON.parse(sql(`select jsonb_build_object('jobname',jobname,'schedule',schedule,'command',command,'active',active,'username',username) from cron.job where jobid=${jobId}`)),
      {jobname:'booking-expiry-sweep',schedule:'* * * * *',command:'select private.booking_expiry_sweep(100)',active:true,username:'postgres'});
    const cronRental=rent(4,courts[1],780,840).id;const cronGroup=join(1,session(1020,1080,8),2);
    elapseRentals([cronRental]);elapseGroups([cronGroup]);const since=sql('select clock_timestamp();');
    checkJob=sql(`select cron.schedule('t32-sweep-check','2 seconds','select private.booking_expiry_sweep(100)');`);
    await until(()=>stored(cronRental)==='expired'&&stored(cronGroup)==='expired','Cron sweep expired the holds',100);
    assert.ok(Number(sql(`select count(*) from cron.job_run_details where jobid in (${jobId},${checkJob}) and status='succeeded' and start_time>='${since}'`))>0,'Cron run succeeded');
    swept([cronRental,cronGroup]);invariant();
    console.log(`PASS: pg_cron ${sql("select extversion from pg_extension where extname='pg_cron'")}: schedule helper is idempotent (one '* * * * *' postgres job); a cron-run sweep expired a rental and a group once with system events.`);
  }finally{
    for(const worker of workers)worker.kill();let clean=true;const steps=[];
    if(checkJob)steps.push(()=>sql(`select cron.unschedule(${checkJob});delete from cron.job_run_details where jobid=${checkJob};`));
    if(cronCreated)steps.push(()=>sql('drop extension pg_cron;'));
    else if(scheduled&&jobBefore==='')steps.push(()=>sql(`delete from cron.job_run_details where jobid=(select jobid from cron.job where jobname='booking-expiry-sweep');
      select cron.unschedule('booking-expiry-sweep');`));
    else if(scheduled&&jobBefore){const job=JSON.parse(jobBefore);
      steps.push(()=>sql(`select cron.alter_job(${job.jobid},schedule:='${job.schedule}',command:=$cmd$${job.command}$cmd$,active:=${job.active});`));}
    if(venueCreated)steps.push(()=>sql(`delete from public.venues where id='${venue}';delete from private.directory_audit_events where target_venue_id='${venue}';`));
    if(usersCreated)steps.push(()=>sql(`delete from auth.users where id=any(${ids(users)});`));
    for(const step of steps)try{step();}catch{clean=false;}
    assert.ok(clean,'Own fixtures and cron jobs removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs and pg_cron state preserved');
  }
  console.log('PASS: own fixtures, accounts, audits and cron jobs removed; pg_cron state and pre-existing IDs preserved; no hosted changes.');
}
main().catch(error=>{console.error(`Local hold-sweep check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations and Docker setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;});
