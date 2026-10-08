// T31: real local Docker/Auth/PostgREST, independent lock sessions, the shipped desk/player clients and served Edge. No hosted/mobile env.
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
    'rentals',(select jsonb_agg(id order by id) from private.rental_bookings),'rental_events',(select jsonb_agg(id order by id) from private.rental_events),
    'sessions',(select jsonb_agg(id order by id) from private.open_play_sessions),'groups',(select jsonb_agg(id order by id) from private.session_bookings),
    'group_events',(select jsonb_agg(id order by id) from private.session_booking_events),'operations',(select jsonb_agg(booking_id order by booking_id) from private.booking_operations),
    'audit',(select jsonb_agg(id order by id) from private.directory_audit_events));`);
  const beforeInventory=inventory();
  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'booking-operations.sql'),'utf8'));
  console.log('PASS: Docker operations SQL: outside rentals share inventory/keys/locks; attendance and payments are owner-only, start-gated, retry-safe, audited, append-only and roll back with their event.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(r,message)=>{assert.ok(!r.error,message);return r.data;};const users=[],clients=[],tokens=[];const venue=randomUUID();
  const courts=[randomUUID(),randomUUID(),randomUUID()].sort();let created=false;let child;const workers=new Set();const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-desk-'));
  const dbSession=query=>new Promise(resolve=>{
    const worker=spawn(docker,args,{windowsHide:true});workers.add(worker);let out='',err='';
    worker.stdout.on('data',d=>out+=d);worker.stderr.on('data',d=>err+=d);
    worker.on('error',()=>resolve({code:-1,out,err}));worker.on('close',code=>{workers.delete(worker);resolve({code,out:out.trim(),err});});worker.stdin.end(query);
  });
  const heldRace=async(first,second)=>{
    const name=`pickly-desk-${randomUUID()}`;
    const holder=dbSession(`set application_name='${name}';begin;${first}select pg_sleep(1.89);commit;`);
    let observed=false;
    for(let n=0;n<100&&!observed;n++){
      observed=sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event='PgSleep'`)==='1';
      if(!observed)await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(observed,'Observed holder locks');const competitor=await dbSession(second);const winner=await holder;assert.equal(winner.code,0,'Holder committed');return competitor;
  };
  const rentalModule=load(path.join(__dirname,'../functions/rental-bookings/handler.ts'),{},{TextDecoder});
  const {createSupabaseRentalDeps}=load(path.join(__dirname,'../functions/rental-bookings/deps.ts'),{'./handler.ts':rentalModule});
  const groupModule=load(path.join(__dirname,'../functions/session-bookings/handler.ts'),{},{TextDecoder});
  const {createSupabaseSessionBookingDeps}=load(path.join(__dirname,'../functions/session-bookings/deps.ts'),{'./handler.ts':groupModule});
  const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();
  const nowWindow=`to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes'`;
  // Trusted SQL stands in for time passing until a booking starts.
  // Snapshots move with the interval (single-rate fixtures) so the shipped parsers still see one consistent record.
  const startRental=id=>sql(`begin;alter table private.rental_snapshots disable trigger rental_snapshot_immutable;
    update private.court_allocations set starts_at=${nowWindow},ends_at=${nowWindow}+(ends_at-starts_at) where id='${id}';
    update private.rental_snapshots s set snapshot=s.snapshot||jsonb_build_object('starts_at',a.starts_at,'ends_at',a.ends_at,
      'bands',jsonb_build_array((s.snapshot->'bands'->0)||jsonb_build_object('starts_at',a.starts_at,'ends_at',a.ends_at)))
      from private.court_allocations a where a.id=s.allocation_id and s.allocation_id='${id}';
    alter table private.rental_snapshots enable trigger rental_snapshot_immutable;commit;`);
  const startSession=id=>sql(`begin;alter table private.open_play_sessions disable trigger session_immutable;
    alter table private.session_bookings disable trigger session_booking_guard;
    update private.open_play_sessions set starts_at=${nowWindow},ends_at=${nowWindow}+(ends_at-starts_at) where id='${id}';
    update private.open_play_sessions set snapshot=snapshot||jsonb_build_object('starts_at',starts_at,'ends_at',ends_at) where id='${id}';
    update private.session_bookings b set snapshot=b.snapshot||jsonb_build_object('starts_at',s.starts_at,'ends_at',s.ends_at)
      from private.open_play_sessions s where s.id=b.session_id and s.id='${id}';
    alter table private.session_bookings enable trigger session_booking_guard;
    alter table private.open_play_sessions enable trigger session_immutable;commit;`);
  const rentalEvents=id=>JSON.parse(sql(`select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from private.rental_events where booking_id='${id}' group by action) x;`));
  const groupEvents=id=>JSON.parse(sql(`select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from private.session_booking_events where booking_id='${id}' group by action) x;`));
  const sorted=list=>[...list].sort();
  try{
    for(let n=0;n<6;n++){
      const credentials={email:`desk-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own account').user.id);
      const c=createClient(api.href,config.ANON_KEY,options);clients.push(c);tokens.push(check(await c.auth.signInWithPassword(credentials),'Own login').session.access_token);
    }
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Desk Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);created=true;
    sql(`insert into public.courts(id,venue_id,name) values('${courts[0]}','${venue}','A'),('${courts[1]}','${venue}','B'),('${courts[2]}','${venue}','C');
      insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',0,'end_minute',1440,'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));`);
    const enforced=async()=>({allowed:true,status:200,state:'enforced',headers:{}});const server=()=>createClient(api.href,config.SERVICE_ROLE_KEY,options);
    const rentals=rentalModule.createRentalHandler({...createSupabaseRentalDeps(()=>anon,server),limit:enforced});
    const groups=groupModule.createSessionBookingHandler({...createSupabaseSessionBookingDeps(()=>anon,server),limit:enforced});
    const call=(handler,user,command)=>handler(new Request('https://local.test',{method:'POST',headers:{authorization:`Bearer ${tokens[user]}`,'content-type':'application/json'},body:JSON.stringify(command)}));
    const read=(handler,user,tail)=>handler(new Request(`https://local.test?${tail}`,{headers:{authorization:`Bearer ${tokens[user]}`}}));
    const quote=async(court,a,b)=>(await (await read(rentals,1,`section=quote&court_id=${court}&starts_at=${at(a)}&ends_at=${at(b)}`)).json()).quote.expected_quote;
    const window=(court,a,b,expected)=>({court_id:court,starts_at:at(a),ends_at:at(b),expected_quote:expected});
    const entry=(court,a,b,expected,guest='Walk-up guest',request=randomUUID())=>({kind:'owner_entry',...window(court,a,b,expected),request_id:request,guest_name:guest});
    const request=(court,a,b,expected,key=randomUUID())=>({kind:'request',...window(court,a,b,expected),request_id:key});
    // Three outside rentals and three player rentals race for the same court hour: exactly one wins under the shared court lock.
    const hour=await quote(courts[0],600,660);
    const race=await Promise.all([...[1,2,3].map(()=>call(rentals,0,entry(courts[0],600,660,hour))),...[1,2,3].map(p=>call(rentals,p,request(courts[0],600,660,hour)))]);
    const raceBodies=await Promise.all(race.map(r=>r.json()));
    assert.equal(race.filter(r=>r.status===200).length,1);assert.ok(raceBodies.every((b,i)=>race[i].status===200||b.error==='allocation_conflict'));
    assert.equal(sql(`select count(*) from private.court_allocations where court_id='${courts[0]}' and state='active'`),'1');
    const retryBody=entry(courts[0],720,780,await quote(courts[0],720,780),'Phone booking');
    const retries=await Promise.all(Array.from({length:6},()=>call(rentals,0,retryBody)));assert.ok(retries.every(r=>r.status===200));
    const retryReplies=await Promise.all(retries.map(r=>r.json()));assert.deepEqual(sorted(retryReplies.map(r=>r.outcome)),['created',...Array(5).fill('existing')]);
    const outside=retryReplies[0].booking;assert.equal(new Set(retryReplies.map(r=>r.booking.id)).size,1);assert.deepEqual(rentalEvents(outside.id),{owner_entry:1});
    assert.equal(outside.source,'owner');assert.equal(outside.guest_name,'Phone booking');assert.equal(outside.status,'confirmed');
    assert.equal((await (await call(rentals,0,{...retryBody,kind:'request',guest_name:undefined})).json()).error,'request_reused');
    assert.equal((await (await call(rentals,1,entry(courts[0],780,840,await quote(courts[0],780,840)))).json()).error,'not_owner');
    assert.equal((await read(rentals,1,`section=booking&booking_id=${outside.id}`)).status,403);
    assert.ok(!(await (await read(rentals,0,'section=history')).json()).bookings.some(b=>b.source==='owner'));
    console.log('PASS: real API three outside rentals and three player rentals for one court hour leave exactly one winner; six entry retries record one booking/event; keys never cross; players cannot enter or read entries.');
    // Forced lock orders: a session or block holding the court vs an outside rental, and an outside rental vs a later block.
    const entrySql=(court,a,b,expected,guest='Held guest')=>`select public.rental_booking_owner_entry('${users[0]}','${court}','${randomUUID()}','${at(a)}','${at(b)}','${guest}',${literal(expected)});`;
    const sessionSql=(court,a,b)=>`select public.owner_session_create('${users[0]}',${literal({venue_id:venue,request_id:randomUUID(),court_ids:[court],title:'Held play',
      starts_at:at(a),ends_at:at(b),capacity:8,group_limit:4,price_centavos:25000})});`;
    const blockSql=(court,a,b)=>`select public.court_allocation_block('${users[0]}','${court}','${randomUUID()}','${at(a)}','${at(b)}');`;
    let competitor=await heldRace(sessionSql(courts[1],600,720),entrySql(courts[1],630,690,await quote(courts[1],630,690)));
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Court already allocated/);
    competitor=await heldRace(entrySql(courts[1],780,840,await quote(courts[1],780,840)),blockSql(courts[1],780,840));
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Court already allocated/);
    competitor=await heldRace(blockSql(courts[1],900,960),entrySql(courts[1],930,990,await quote(courts[1],930,990)));
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Court already allocated/);
    console.log('PASS: observed lock waits: session-first and block-first refuse the outside rental; entry-first refuses the block.');
    // Front desk on started bookings: concurrent check-ins/payments record once; no-show and check-in never both win.
    const rented=(await (await call(rentals,1,request(courts[2],900,960,await quote(courts[2],900,960)))).json()).booking;startRental(rented.id);
    const checkIns=await Promise.all(Array.from({length:6},()=>call(rentals,0,{kind:'check_in',booking_id:rented.id})));assert.ok(checkIns.every(r=>r.status===200));
    assert.deepEqual(sorted((await Promise.all(checkIns.map(r=>r.json()))).map(r=>r.outcome)),['changed',...Array(5).fill('existing')]);
    const pay={kind:'record_payment',booking_id:rented.id,method:'cash',amount_centavos:rented.snapshot.total_centavos};
    const pays=await Promise.all(Array.from({length:6},()=>call(rentals,0,pay)));assert.ok(pays.every(r=>r.status===200));
    assert.equal((await (await call(rentals,0,{...pay,method:'card'})).json()).error,'payment_recorded');
    assert.equal((await (await call(rentals,0,{...pay,amount_centavos:pay.amount_centavos+1})).json()).error,'payment_recorded');
    assert.deepEqual(rentalEvents(rented.id),{request:1,check_in:1,payment:1});
    const booked=sql(`select jsonb_build_object('status',b.status,'updated_at',b.updated_at,'snapshot',s.snapshot) from private.rental_bookings b
      join private.rental_snapshots s on s.allocation_id=b.id where b.id='${rented.id}'`);
    const walkUp=(await (await call(rentals,0,entry(courts[0],840,900,await quote(courts[0],840,900),'Counter guest'))).json()).booking;startRental(walkUp.id);
    const mixed=await Promise.all([...Array(3).fill('no_show'),...Array(3).fill('check_in')].map(kind=>call(rentals,0,{kind,booking_id:walkUp.id})));
    const mixedBodies=await Promise.all(mixed.map(r=>r.json()));const winner=mixedBodies.find(b=>b.outcome==='changed').booking.operations.attendance;
    assert.equal(mixedBodies.filter(b=>b.outcome==='changed').length,1);
    assert.ok(mixedBodies.every((b,i)=>mixed[i].status===200?b.booking.operations.attendance===winner:b.error==='invalid_transition'));
    assert.deepEqual(rentalEvents(walkUp.id),{owner_entry:1,[winner==='no_show'?'no_show':'check_in']:1});
    const revoke=`select id from public.venues where id='${venue}' for update;delete from private.venue_owners where venue_id='${venue}';`;
    competitor=await heldRace(revoke,`select public.booking_operation('${users[0]}','rental','${rented.id}','complete');`);
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Owner required/);
    sql(`insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}');`);
    console.log(`PASS: real API six check-ins and six payments record one event each; a different payment is refused; mixed no-show/check-in leaves one winner (${winner}); revocation-first refuses completion.`);
    // Groups: a player group and a walk-in in a session that has started.
    const session=check(await service.rpc('owner_session_create',{actor_user_id:users[0],session_input:{venue_id:venue,request_id:randomUUID(),court_ids:[courts[2]],
      title:'Desk play',starts_at:at(1080),ends_at:at(1200),capacity:8,group_limit:4,price_centavos:25000}}),'Own session').session.id;
    const groupBody={kind:'request',session_id:session,request_id:randomUUID(),participants:['Ana','Ben'],expected_total_centavos:50000};
    const playerGroup=(await (await call(groups,2,groupBody)).json()).booking;
    assert.equal((await (await call(groups,0,{kind:'check_in',booking_id:playerGroup.id})).json()).error,'not_started');
    startSession(session);
    const walkInGroup=(await (await call(groups,0,{...groupBody,kind:'walk_in',request_id:randomUUID(),participants:['Cy'],expected_total_centavos:25000})).json()).booking;
    competitor=await heldRace(`select public.booking_operation('${users[0]}','session','${playerGroup.id}','check_in');`,
      `select public.booking_operation('${users[0]}','session','${playerGroup.id}','no_show');`);
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/cannot change/);
    assert.equal((await (await call(groups,2,{kind:'check_in',booking_id:playerGroup.id})).json()).error,'not_owner');
    assert.equal((await (await call(groups,2,{kind:'cancel',booking_id:playerGroup.id})).json()).error,'invalid_transition');
    console.log('PASS: group records start at the session start; check-in-first refuses a waiting no-show; players cannot record or cancel after the start.');
    // The shipped mobile desk and player clients against verified Auth + real PostgreSQL, with one lost committed outside-rental reply.
    const {desk,rental:mobile}=require('../../src/features/owner/__tests__/deskHelpers.cjs');const play=require('../../src/features/openPlay/__tests__/helpers.cjs');
    let loseEntryReply=true;
    const via=(handler,user)=>({endpoint:'https://local.test',apiKey:config.ANON_KEY,accessToken:async()=>tokens[user],fetch:async(url,init)=>{
      const response=await handler(new Request(url,init));
      if(init.method==='POST'&&JSON.parse(init.body).kind==='owner_entry'&&loseEntryReply){loseEntryReply=false;throw new Error('Lost reply after commit');}
      return {ok:response.ok,status:response.status,headers:response.headers,json:()=>response.json()};
    }});
    const ownerDesk={rental:via(rentals,0),group:via(groups,0)};const today=sql(`select ((${nowWindow}) at time zone 'Asia/Manila')::date`);
    const rentalDay=await desk.loadDay(ownerDesk,'rental',venue,today,null);assert.equal(rentalDay.ok,true,'Desk rental day parser');
    assert.deepEqual(sorted(rentalDay.value.bookings.map(b=>b.booking.id)),sorted([rented.id,walkUp.id]));
    const groupDay=await desk.loadDay(ownerDesk,'group',venue,today,null);assert.equal(groupDay.ok,true,'Desk group day parser');
    assert.deepEqual(sorted(groupDay.value.bookings.map(b=>b.booking.id)),sorted([playerGroup.id,walkInGroup.id]));
    const done=await desk.operate(ownerDesk,'rental',{kind:'complete',booking_id:rented.id});assert.equal(done.ok,true);assert.equal(done.value.booking.booking.operations.attendance,'completed');
    const groupPaid=await desk.operate(ownerDesk,'group',{kind:'record_payment',booking_id:playerGroup.id,method:'ewallet',amount_centavos:50000});assert.equal(groupPaid.ok,true);
    const expected=await quote(courts[1],1080,1140);const journal=desk.createEntryJournal(mobile.memory(),'local.owner');
    const command=mobile.domain.readRentalCommand({kind:'owner_entry',...window(courts[1],1080,1140,expected),request_id:randomUUID(),guest_name:'Lost reply guest'});
    assert.equal((await journal.run(command,c=>desk.enterOutsideRental(ownerDesk,c))).failure.kind,'network');
    const recovered=await journal.run(await journal.read(),c=>desk.enterOutsideRental(ownerDesk,c));
    assert.equal(recovered.ok,true);assert.equal(recovered.value.outcome,'existing');assert.equal(await journal.read(),null);
    assert.equal(sql(`select count(*) from private.court_allocations where request_id='${command.request_id}'`),'1');assert.deepEqual(rentalEvents(recovered.value.booking.id),{owner_entry:1});
    sql(`select public.owner_venue_policy_save('${users[0]}','${venue}',(select private.venue_policy_view('${venue}')->>'revision'),'{"confirmation":"approval","payment":"arrival"}');`);
    const pendingRental=(await (await call(rentals,3,request(courts[1],1200,1260,await quote(courts[1],1200,1260)))).json()).booking;assert.equal(pendingRental.status,'pending');
    const queue=await desk.loadRequests(ownerDesk,'rental',venue,null);assert.equal(queue.ok,true);assert.deepEqual(queue.value.bookings.map(b=>b.booking.id),[pendingRental.id]);
    const accepted=await desk.decide(ownerDesk,'rental',pendingRental.id,'accept');assert.equal(accepted.ok,true);assert.equal(accepted.value.booking.booking.status,'confirmed');
    const playerView=await mobile.client.loadBooking(via(rentals,1),rented.id);assert.equal(playerView.ok,true,'Player rental parser');
    assert.equal(playerView.value.operations.attendance,'completed');assert.equal(playerView.value.payment_status,'paid');assert.equal(playerView.value.operations.payment.method,'cash');
    const groupView=await play.client.loadGroupBooking(via(groups,2),playerGroup.id);assert.equal(groupView.ok,true,'Player group parser');
    assert.equal(groupView.value.operations.attendance,'checked_in');assert.equal(groupView.value.payment_status,'paid');
    assert.equal(sql(`select jsonb_build_object('status',b.status,'updated_at',b.updated_at,'snapshot',s.snapshot) from private.rental_bookings b
      join private.rental_snapshots s on s.allocation_id=b.id where b.id='${rented.id}'`),booked,'Status and snapshot unchanged by records');
    console.log('PASS: shipped desk client lists today’s rentals/groups, records completion and a group payment, recovers one lost outside-rental reply as one booking/event and accepts a queued request; players read their attendance and payment.');
    // Serve the actual pinned Deno Edge runtime, with Redis deliberately absent.
    const envPath=path.join(temp,'functions.env');fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\n`);
    // A killed Windows `functions serve` leaves its container running; wait for a fresh one before trusting replies.
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    child=spawn(cli,['functions','serve','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const invoke=(name,token,tail='',init={})=>fetch(new URL(`functions/v1/${name}`,api).href+tail,{...init,
      headers:{apikey:config.ANON_KEY,...(token?{authorization:`Bearer ${token}`}:{}),...init.headers},signal:AbortSignal.timeout(20000)});
    const send=(name,user,command)=>invoke(name,tokens[user],'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)});
    let ready=false;for(let n=0;n<120;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{const current=edgeId();if(current&&current!==staleEdge&&(await invoke('rental-bookings',null)).status===401&&(await invoke('session-bookings',null)).status===401){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,500));}
    assert.ok(ready,'Fresh Edge ready');
    const forged=`${tokens[0].split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[0],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await invoke('rental-bookings',forged,`?section=day&venue_id=${venue}&date=${today}`)).status,401);
    const before=sql(`select count(*) from private.court_allocations`);
    const stopped=await send('rental-bookings',0,entry(courts[1],1320,1380,await quote(courts[1],1320,1380)));
    assert.equal(stopped.status,503);assert.equal(stopped.headers.get('retry-after'),'5');assert.equal(sql(`select count(*) from private.court_allocations`),before);
    assert.equal((await invoke('rental-bookings',tokens[0],`?section=day&venue_id=${venue}&date=${today}`)).status,200);
    const walkInCheck=await Promise.all(Array.from({length:3},()=>send('session-bookings',0,{kind:'check_in',booking_id:walkInGroup.id})));
    assert.ok(walkInCheck.every(r=>r.status===200));
    const walkInPay=await send('session-bookings',0,{kind:'record_payment',booking_id:walkInGroup.id,method:'cash',amount_centavos:25000});assert.equal(walkInPay.status,200);
    assert.equal((await walkInPay.json()).booking.payment_status,'paid');assert.deepEqual(groupEvents(walkInGroup.id),{walk_in:1,check_in:1,payment:1});
    const finished=await send('rental-bookings',0,{kind:'no_show',booking_id:recovered.value.booking.id});assert.equal(finished.status,409);
    assert.equal((await finished.json()).error,'not_started');
    console.log('PASS: actual served Edge forged JWT401, Redis-outage outside rental503 with no write; day read200; walk-in check-in retries and payment200 record once; early no-show409.');
  }finally{
    if(child&&child.exitCode===null)child.kill();for(const worker of workers)worker.kill();let clean=true;const steps=[];
    if(created)steps.push(()=>sql(`delete from public.venues where id='${venue}';`));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own account cleanup'));
    steps.push(()=>sql(`delete from private.directory_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-desk-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,anon,...clients])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own fixtures/accounts/audits/temp removed; pre-existing IDs preserved; no hosted changes.');
}
main().catch(error=>{console.error(`Local front-desk check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;});
