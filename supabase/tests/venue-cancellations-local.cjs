// T40a: real local Docker/Auth/PostgREST, independent lock sessions, the shipped desk/session/player clients and served Edge. No hosted/mobile env.
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
    'group_events',(select jsonb_agg(id order by id) from private.session_booking_events),'cancellations',(select jsonb_agg(booking_id order by booking_id) from private.booking_cancellations),
    'outbox',(select jsonb_agg(id order by id) from private.notification_outbox),'devices',(select jsonb_agg(id order by id) from private.push_devices),
    'audit',(select jsonb_agg(id order by id) from private.directory_audit_events));`);
  const beforeInventory=inventory();
  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'venue-cancellations.sql'),'utf8'));
  console.log('PASS: Docker venue-cancellation SQL: owner-only, confirmed future player bookings, front-desk records refused, retries keep the first reason, released inventory, audited sessions, player alerts with the reason, immutable records and event rollback.');
  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(r,message)=>{assert.ok(!r.error,message);return r.data;};const users=[],clients=[],tokens=[];const venue=randomUUID();
  const courts=[randomUUID(),randomUUID(),randomUUID()].sort();let created=false;let child;const workers=new Set();const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-cancel-'));
  const dbSession=query=>new Promise(resolve=>{
    const worker=spawn(docker,args,{windowsHide:true});workers.add(worker);let out='',err='';
    worker.stdout.on('data',d=>out+=d);worker.stderr.on('data',d=>err+=d);
    worker.on('error',()=>resolve({code:-1,out,err}));worker.on('close',code=>{workers.delete(worker);resolve({code,out:out.trim(),err});});worker.stdin.end(query);
  });
  // The holder keeps its locks for ~2 s; the competitor starts only once the holder is observed sleeping inside its transaction.
  const heldRace=async(first,second)=>{
    const name=`pickly-cancel-${randomUUID()}`;
    const holder=dbSession(`set application_name='${name}';begin;${first}select pg_sleep(1.89);commit;`);
    let observed=false;
    for(let n=0;n<100&&!observed;n++){
      observed=sql(`select count(*) from pg_stat_activity where application_name='${name}' and wait_event='PgSleep'`)==='1';
      if(!observed)await new Promise(r=>setTimeout(r,30));
    }
    assert.ok(observed,'Observed holder locks');const competitor=await dbSession(second);const winner=await holder;assert.equal(winner.code,0,`Holder committed: ${winner.err}`);return competitor;
  };
  const fn=(name,file)=>path.join(__dirname,'../functions',name,file);
  const rentalModule=load(fn('rental-bookings','handler.ts'),{},{TextDecoder});
  const {createSupabaseRentalDeps}=load(fn('rental-bookings','deps.ts'),{'./handler.ts':rentalModule});
  const groupModule=load(fn('session-bookings','handler.ts'),{},{TextDecoder});
  const {createSupabaseSessionBookingDeps}=load(fn('session-bookings','deps.ts'),{'./handler.ts':groupModule});
  const sessionModule=load(fn('owner-sessions','handler.ts'),{},{TextDecoder});
  const {createSupabaseSessionDeps}=load(fn('owner-sessions','deps.ts'),{'./handler.ts':sessionModule});
  const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();
  const rentalEvents=id=>JSON.parse(sql(`select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from private.rental_events where booking_id='${id}' group by action) x;`));
  const groupEvents=id=>JSON.parse(sql(`select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from private.session_booking_events where booking_id='${id}' group by action) x;`));
  const audit=id=>JSON.parse(sql(`select coalesce((select jsonb_build_object('actor',actor_user_id,'reason',reason,'session',session_id) from private.booking_cancellations where booking_id='${id}'),'null')`));
  // Outbox rows written for a booking's cancel event: recipient index and reason.
  const alerts=(id,source)=>JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('to',o.recipient_user_id,'reason',o.payload->'reason') order by o.recipient_user_id),'[]')
    from private.notification_outbox o where o.source='${source}' and o.event_id in (select e.id from private.${source==='rental'?'rental_events':'session_booking_events'} e
    where e.booking_id='${id}' and e.action='cancel')`)).map(a=>({to:users.indexOf(a.to),reason:a.reason}));
  const sorted=list=>[...list].sort();
  try{
    // u0 owner, u1 co-owner (joins below), u2/u3 players with phones, u4 an unrelated account.
    for(let n=0;n<5;n++){
      const credentials={email:`cancel-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`};
      users.push(check(await service.auth.admin.createUser({...credentials,email_confirm:true}),'Own account').user.id);
      const c=createClient(api.href,config.ANON_KEY,options);clients.push(c);tokens.push(check(await c.auth.signInWithPassword(credentials),'Own login').session.access_token);
    }
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${venue}','Local Cancellation Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');`);created=true;
    sql(`insert into public.courts(id,venue_id,name) values('${courts[0]}','${venue}','A'),('${courts[1]}','${venue}','B'),('${courts[2]}','${venue}','C');
      insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}'),('${users[1]}','${venue}');
      select public.venue_schedule_save('${users[0]}','${venue}',null,jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object(
        'start_minute',0,'end_minute',1440,'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000)))))
        from generate_series(1,7)),'exceptions','[]'::jsonb));`);
    for(const n of [2,3]) check(await service.rpc('push_device_register',{actor_user_id:users[n],device_input:{token:`ExponentPushToken[cancel-${randomUUID()}]`,platform:'ios'}}),'Own device');
    const enforced=async()=>({allowed:true,status:200,state:'enforced',headers:{}});const server=()=>createClient(api.href,config.SERVICE_ROLE_KEY,options);
    const rentals=rentalModule.createRentalHandler({...createSupabaseRentalDeps(()=>anon,server),limit:enforced});
    const groups=groupModule.createSessionBookingHandler({...createSupabaseSessionBookingDeps(()=>anon,server),limit:enforced});
    const sessions=sessionModule.createSessionHandler({...createSupabaseSessionDeps(()=>anon,server),limit:enforced});
    const call=(handler,user,command)=>handler(new Request('https://local.test',{method:'POST',headers:{authorization:`Bearer ${tokens[user]}`,'content-type':'application/json'},body:JSON.stringify(command)}));
    const read=(handler,user,tail)=>handler(new Request(`https://local.test?${tail}`,{headers:{authorization:`Bearer ${tokens[user]}`}}));
    const quote=async(court,a,b)=>(await (await read(rentals,2,`section=quote&court_id=${court}&starts_at=${at(a)}&ends_at=${at(b)}`)).json()).quote.expected_quote;
    const rent=async(user,court,a,b)=>{const r=await call(rentals,user,{kind:'request',court_id:court,starts_at:at(a),ends_at:at(b),request_id:randomUUID(),
      expected_quote:await quote(court,a,b)});const body=await r.json();assert.equal(r.status,200,body.error);return body.booking;};
    const rentSql=(user,court,a,b)=>`select public.rental_booking_request('${users[user]}','${court}','${randomUUID()}','${at(a)}','${at(b)}',
      public.rental_booking_quote('${users[user]}','${court}','${at(a)}','${at(b)}')->'expected_quote');`;
    const createSession=async(a,b)=>check(await service.rpc('owner_session_create',{actor_user_id:users[0],session_input:{venue_id:venue,request_id:randomUUID(),
      court_ids:[courts[2]],title:'Cancel play',starts_at:at(a),ends_at:at(b),capacity:8,group_limit:4,price_centavos:25000}}),'Own session').session.id;
    const groupBody=(sessionId,names)=>({session_id:sessionId,request_id:randomUUID(),participants:names,expected_total_centavos:25000*names.length});
    const join=async(user,sessionId,names)=>{const r=await call(groups,user,{kind:'request',...groupBody(sessionId,names)});const body=await r.json();assert.equal(r.status,200,body.error);return body.booking;};
    const walkIn=async(sessionId,names)=>(await (await call(groups,0,{kind:'walk_in',...groupBody(sessionId,names)})).json()).booking;
    const cancel=(user,id,reason,handler=rentals)=>call(handler,user,{kind:'venue_cancel',booking_id:id,reason});

    // Six owner cancellations race with different reasons: one changes the booking, five return it with the first reason.
    const r1=await rent(2,courts[0],600,660);const reasons=['weather','maintenance','venue_closed','schedule_conflict','player_request','other'];
    assert.equal((await (await cancel(2,r1.id,'weather')).json()).error,'not_owner');assert.equal((await (await cancel(4,r1.id,'weather')).json()).error,'not_owner');
    const raced=await Promise.all(reasons.map((reason,n)=>cancel(n%2,r1.id,reason)));assert.ok(raced.every(r=>r.status===200));
    const racedBodies=await Promise.all(raced.map(r=>r.json()));const first=racedBodies.find(b=>b.outcome==='changed').booking.venue_cancellation.reason;
    assert.deepEqual(sorted(racedBodies.map(b=>b.outcome)),['changed',...Array(5).fill('existing')]);
    assert.ok(racedBodies.every(b=>b.booking.status==='cancelled'&&b.booking.venue_cancellation.reason===first&&b.booking.allocation.state==='released'));
    assert.deepEqual(rentalEvents(r1.id),{request:1,cancel:1});assert.equal(audit(r1.id).reason,first);
    assert.deepEqual(alerts(r1.id,'rental'),[{to:2,reason:first}]);
    assert.equal((await rent(3,courts[0],600,660)).status,'confirmed');
    console.log(`PASS: real API six owner/co-owner cancellations with different reasons → one change (${first}), five existing; one event, one audit row and one player alert with the reason; players and strangers get not_owner; the court rebooks at once.`);

    // Owner and player cancel at once: exactly one kind wins.
    const r2=await rent(2,courts[0],720,780);
    const mixed=await Promise.all([...[0,1,0].map((u,n)=>cancel(u,r2.id,reasons[n])),...[1,2,3].map(()=>call(rentals,2,{kind:'cancel',booking_id:r2.id}))]);
    const mixedBodies=await Promise.all(mixed.map(r=>r.json()));const venueWon=audit(r2.id)!==null;
    assert.deepEqual(rentalEvents(r2.id),{request:1,cancel:1});
    assert.ok(mixedBodies.slice(0,3).every(b=>venueWon?b.booking.venue_cancellation!==null:b.error==='invalid_transition'));
    assert.ok(mixedBodies.slice(3).every(b=>b.booking.status==='cancelled'));
    // Owners registered no phone here, so a player's own cancellation queues nothing.
    assert.deepEqual(alerts(r2.id,'rental').map(a=>a.to),venueWon?[2]:[]);
    console.log(`PASS: real API three owner and three player cancellations of one booking cancel it once (${venueWon?'venue':'player'} first); the other side is told nothing twice.`);

    // Observed lock orders.
    const r3=await rent(2,courts[0],840,900);
    let competitor=await heldRace(`select public.rental_booking_change('${users[2]}','${r3.id}','cancel');`,`select public.owner_booking_cancel('${users[0]}','rental','${r3.id}','weather');`);
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/cannot change/);assert.equal(audit(r3.id),null);
    const r4=await rent(2,courts[0],960,1020);
    competitor=await heldRace(`select public.owner_booking_cancel('${users[0]}','rental','${r4.id}','maintenance');`,`select public.rental_booking_change('${users[2]}','${r4.id}','cancel')->>'outcome';`);
    assert.equal(competitor.code,0);assert.equal(competitor.out,'existing');assert.deepEqual(rentalEvents(r4.id),{request:1,cancel:1});assert.equal(audit(r4.id).reason,'maintenance');
    const r5=await rent(2,courts[1],600,660);
    competitor=await heldRace(`select public.owner_booking_cancel('${users[0]}','rental','${r5.id}','venue_closed');`,`${rentSql(3,courts[1],600,660)}`);
    assert.equal(competitor.code,0,competitor.err);assert.match(competitor.out,/"status": ?"confirmed"/);
    const r6=await rent(2,courts[1],720,780);
    competitor=await heldRace(`select id from public.venues where id='${venue}' for update;delete from private.venue_owners where venue_id='${venue}';`,
      `select public.owner_booking_cancel('${users[0]}','rental','${r6.id}','weather');`);
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Owner required/);assert.equal(audit(r6.id),null);
    sql(`insert into private.venue_owners(user_id,venue_id) values('${users[0]}','${venue}'),('${users[1]}','${venue}');`);
    console.log('PASS: observed lock waits: player-cancel-first refuses the venue cancellation; venue-first leaves the player an existing reply; a request waiting on the court books it once released; revocation-first refuses the owner.');

    // Whole sessions: six racing cancellations of an occupied session cancel every group and walk-in once and alert each player group.
    const s1=await createSession(600,720);const g1=await join(2,s1,['Ana','Ben']);const g2=await join(3,s1,['Cy']);const w1=await walkIn(s1,['Dee']);
    assert.equal((await (await call(sessions,0,{kind:'cancel',session_id:s1})).json()).error,'session_has_bookings');
    assert.equal((await (await call(sessions,4,{kind:'cancel',session_id:s1,reason:'weather'})).json()).error,'not_owner');
    const sessionRace=await Promise.all(Array.from({length:6},(_,n)=>call(sessions,n%2,{kind:'cancel',session_id:s1,reason:n<3?'weather':'maintenance'})));
    assert.ok(sessionRace.every(r=>r.status===200));const sessionBodies=await Promise.all(sessionRace.map(r=>r.json()));
    assert.deepEqual(sorted(sessionBodies.map(b=>b.outcome)),['cancelled',...Array(5).fill('existing')]);
    const sessionReason=sessionBodies.find(b=>b.outcome==='cancelled').session.cancel_reason;
    assert.ok(sessionBodies.every(b=>b.session.status==='cancelled'&&b.session.cancel_reason===sessionReason&&b.session.reserved_spots===0
      &&b.session.allocations.every(a=>a.state==='released')));
    for(const g of [g1,g2,w1]){assert.equal(audit(g.id).reason,sessionReason);assert.equal(audit(g.id).session,s1);assert.equal(groupEvents(g.id).cancel,1);}
    assert.deepEqual(alerts(g1.id,'session'),[{to:2,reason:sessionReason}]);assert.deepEqual(alerts(g2.id,'session'),[{to:3,reason:sessionReason}]);
    assert.deepEqual(alerts(w1.id,'session'),[]);
    assert.equal((await rent(3,courts[2],600,660)).status,'confirmed');
    // A group request holding the session lock is cancelled with the session; a session cancellation holding it refuses the request.
    const s2=await createSession(780,900);
    competitor=await heldRace(`select public.session_booking_request('${users[3]}',${literal(groupBody(s2,['Eve']))});`,
      `select public.owner_session_cancel('${users[0]}','${s2}','schedule_conflict')->>'outcome';`);
    assert.equal(competitor.code,0,competitor.err);assert.equal(competitor.out,'cancelled');
    const heldGroup=sql(`select id from private.session_bookings where session_id='${s2}'`);assert.equal(audit(heldGroup).reason,'schedule_conflict');
    const s3=await createSession(960,1080);
    competitor=await heldRace(`select public.owner_session_cancel('${users[0]}','${s3}','weather');`,`select public.session_booking_request('${users[2]}',${literal(groupBody(s3,['Fay']))});`);
    assert.notEqual(competitor.code,0);assert.match(competitor.err,/Session cancelled/);
    console.log(`PASS: real API six racing session cancellations → one (${sessionReason}), every group and walk-in cancelled once with an audit row, one alert per player group, none for the walk-in, courts rebook; request-first is cancelled with the session and session-first refuses the request.`);

    // The shipped mobile desk, session and player clients, with one lost committed cancellation reply.
    const {desk,rental:mobile}=require('../../src/features/owner/__tests__/deskHelpers.cjs');const play=require('../../src/features/openPlay/__tests__/helpers.cjs');
    const domain=Object.assign({},...['session','booking','calendar','schedule','cancellation'].map(name=>require(path.join(__dirname,`../../packages/domain/src/${name}.ts`))));
    const venueClient=require('../../src/features/owner/venueClient.ts');const ownerImports={'@picklyph/domain':domain,'./venueClient':venueClient};
    ownerImports['./calendarClient']=load(path.join(__dirname,'../../src/features/owner/calendarClient.ts'),ownerImports);
    const sessionClient=load(path.join(__dirname,'../../src/features/owner/sessionClient.ts'),ownerImports);
    let loseReply=true;
    const via=(handler,user)=>({endpoint:'https://local.test',apiKey:config.ANON_KEY,accessToken:async()=>tokens[user],fetch:async(url,init)=>{
      const response=await handler(new Request(url,init));
      if(init.method==='POST'&&JSON.parse(init.body).kind==='venue_cancel'&&loseReply){loseReply=false;throw new Error('Lost reply after commit');}
      return {ok:response.ok,status:response.status,headers:response.headers,json:()=>response.json()};
    }});
    const ownerDesk={rental:via(rentals,0),group:via(groups,0)};
    const r7=await rent(2,courts[1],840,900);
    assert.equal((await desk.venueCancel(ownerDesk,'rental',r7.id,'player_request')).failure.kind,'network');
    const retried=await desk.venueCancel(ownerDesk,'rental',r7.id,'player_request');assert.equal(retried.ok,true);assert.equal(retried.value.outcome,'existing');
    assert.deepEqual(rentalEvents(r7.id),{request:1,cancel:1});
    const playerView=await mobile.client.loadBooking(via(rentals,2),r7.id);assert.equal(playerView.ok,true,'Player rental parser');
    assert.equal(playerView.value.venue_cancellation.reason,'player_request');assert.equal(mobile.model.bookingStatus(playerView.value).label,'Cancelled by the venue');
    const s4=await createSession(1140,1260);const g4=await join(2,s4,['Gus','Hal']);
    const viaSessions={...via(sessions,0)};
    assert.equal((await sessionClient.cancelSession(viaSessions,s4)).failure.reason,'session_has_bookings');
    const cancelledSession=await sessionClient.cancelSession(viaSessions,s4,'venue_closed');assert.equal(cancelledSession.ok,true,'Session parser');
    assert.equal(cancelledSession.value.session.cancel_reason,'venue_closed');
    const groupView=await play.client.loadGroupBooking(via(groups,2),g4.id);assert.equal(groupView.ok,true,'Player group parser');
    assert.equal(groupView.value.venue_cancellation.reason,'venue_closed');assert.match(play.model.groupStatus(groupView.value).text,/because the venue is closed/);
    console.log('PASS: shipped desk client recovers one lost committed cancellation as the same single cancellation; the session client cancels an occupied session with a reason; players read “Cancelled by the venue” and why.');

    // Serve the actual pinned Deno Edge runtime, with Redis deliberately absent: cancellations continue.
    const envPath=path.join(temp,'functions.env');fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nPICKLY_ENV=local\n`);
    // A killed Windows `functions serve` leaves its container running; wait for a fresh one before trusting replies.
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    child=spawn(cli,['functions','serve','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const invoke=(name,token,tail='',init={})=>fetch(new URL(`functions/v1/${name}`,api).href+tail,{...init,
      headers:{apikey:config.ANON_KEY,...(token?{authorization:`Bearer ${token}`}:{}),...init.headers},signal:AbortSignal.timeout(20000)});
    const send=(name,token,command)=>invoke(name,token,'',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)});
    let ready=false;for(let n=0;n<120;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{const current=edgeId();if(current&&current!==staleEdge&&(await invoke('rental-bookings',null)).status===401&&(await invoke('owner-sessions',null)).status===401){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,500));}
    assert.ok(ready,'Fresh Edge ready');
    const forged=`${tokens[0].split('.')[0]}.${Buffer.from(JSON.stringify({sub:users[0],role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    const r8=await rent(2,courts[1],960,1020);
    assert.equal((await send('rental-bookings',forged,{kind:'venue_cancel',booking_id:r8.id,reason:'weather'})).status,401);
    assert.equal((await send('rental-bookings',tokens[0],{kind:'venue_cancel',booking_id:r8.id,reason:'rain'})).status,400);
    const served=await Promise.all(Array.from({length:3},()=>send('rental-bookings',tokens[0],{kind:'venue_cancel',booking_id:r8.id,reason:'weather'})));
    assert.ok(served.every(r=>r.status===200));assert.deepEqual(sorted((await Promise.all(served.map(r=>r.json()))).map(b=>b.outcome)),['changed','existing','existing']);
    assert.deepEqual(rentalEvents(r8.id),{request:1,cancel:1});
    const s6=check(await service.rpc('owner_session_create',{actor_user_id:users[0],session_input:{venue_id:venue,request_id:randomUUID(),
      court_ids:[courts[0]],title:'Served play',starts_at:at(1080),ends_at:at(1200),capacity:8,group_limit:4,price_centavos:25000}}),'Own session').session.id;
    const g6=await join(2,s6,['Ivy']);const g7=await join(3,s6,['Jo']);
    const groupServed=await send('session-bookings',tokens[1],{kind:'venue_cancel',booking_id:g6.id,reason:'other'});assert.equal(groupServed.status,200);
    assert.equal((await groupServed.json()).booking.venue_cancellation.reason,'other');
    const s5=await createSession(1320,1440);await join(3,s5,['Kai']);
    assert.equal((await send('owner-sessions',tokens[0],{kind:'cancel',session_id:s5})).status,409);
    const sessionServed=await send('owner-sessions',tokens[0],{kind:'cancel',session_id:s5,reason:'maintenance'});assert.equal(sessionServed.status,200);
    assert.equal((await sessionServed.json()).session.cancel_reason,'maintenance');
    assert.equal(groupEvents(g7.id).cancel,undefined,'Other groups untouched');
    console.log('PASS: actual served Edge without Redis: forged JWT 401, unknown reason 400; three rental venue cancellations → one; a group venue cancellation and an occupied session cancellation with a reason 200; a session without a reason 409.');
  }finally{
    if(child&&child.exitCode===null)child.kill();for(const worker of workers)worker.kill();let clean=true;const steps=[];
    if(created)steps.push(()=>sql(`delete from public.venues where id='${venue}';`));
    for(const id of users)steps.push(async()=>check(await service.auth.admin.deleteUser(id),'Own account cleanup'));
    steps.push(()=>sql(`delete from private.directory_audit_events where target_venue_id='${venue}';`));
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-cancel-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,anon,...clients])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own fixtures/accounts/audits/temp removed; pre-existing IDs preserved; no hosted changes.');
}
main().catch(error=>{console.error(`Local venue-cancellation check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;});
