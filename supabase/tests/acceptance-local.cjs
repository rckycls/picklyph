// T48: integrated pilot acceptance across the real pieces together: local Docker/Auth/Storage/PostgREST/Mailpit, the
// production admin console, the shipped Edge handlers in Node (real deps and the real rate guard over an in-memory limiter,
// because the Edge guard only accepts real Upstash), the shipped mobile clients, and served Edge with Redis absent.
// Never reads mobile env or hosted data. Scenario map and the manual iPhone walkthrough: docs/acceptance.md.
const assert=require('node:assert/strict');const fs=require('node:fs');const net=require('node:net');const os=require('node:os');const path=require('node:path');
const {randomUUID}=require('node:crypto');const {execFileSync,spawn}=require('node:child_process');const {createClient}=require('@supabase/supabase-js');
const load=require('./load-ts.cjs');
const root=path.resolve(__dirname,'../..');
const JPEG=new Uint8Array([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0xff,0xd9]);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Shipped Edge handlers with their real Supabase deps (a superset of the globals each one needs).
const globals={TextDecoder,AbortSignal,FormData,Blob,DataView,atob};
const edge=name=>{
  const handler=load(path.join(root,`supabase/functions/${name}/handler.ts`),{},globals);
  return {handler,deps:load(path.join(root,`supabase/functions/${name}/deps.ts`),{'./handler.ts':handler},globals)};
};
const {createRateGuard,RATE_POLICIES}=load(path.join(root,'supabase/functions/_shared/rate-limit.ts'));
// Shipped mobile clients.
const domain=(...names)=>Object.assign({},...names.map(name=>require(path.join(root,`packages/domain/src/${name}.ts`))));
const venueClient=require(path.join(root,'src/features/owner/venueClient.ts'));
const {submitOwner}=require(path.join(root,'src/features/owner/ownerClient.ts'));
const {searchVenues}=require(path.join(root,'src/features/discovery/searchClient.ts'));
const {loadVenueDetail}=require(path.join(root,'src/features/discovery/venueDetail.ts'));
const rental=require(path.join(root,'src/features/rental/__tests__/helpers.cjs'));
const play=require(path.join(root,'src/features/openPlay/__tests__/helpers.cjs'));
const {desk}=require(path.join(root,'src/features/owner/__tests__/deskHelpers.cjs'));
const ownerImports={'@picklyph/domain':domain('session','booking','calendar','schedule'),'./venueClient':venueClient};
const calendar=ownerImports['./calendarClient']=load(path.join(root,'src/features/owner/calendarClient.ts'),ownerImports);
const sessions=load(path.join(root,'src/features/owner/sessionClient.ts'),ownerImports);
const reports=load(path.join(root,'src/features/discovery/reportClient.ts'),{'@picklyph/domain':domain('moderation','booking'),'../owner/venueClient':venueClient});
const deletion=load(path.join(root,'src/features/account/deletionClient.ts'),{'@picklyph/domain':domain('privacy'),'../owner/venueClient':venueClient});

async function main(){
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
  const context=run(['context','show']).trim();const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const sql=query=>run(['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],query).trim();
  const cli=path.join(root,'node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config=JSON.parse(execFileSync(cli,['status','-o','json'],{cwd:root,stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);const inbox=new URL(config.INBUCKET_URL??config.MAILPIT_URL);
  assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback API required');
  assert.ok(inbox.protocol==='http:'&&['localhost','127.0.0.1'].includes(inbox.hostname)&&inbox.port==='54324','Local Mailpit required');
  assert.ok(fs.existsSync(path.join(root,'apps/admin/.next/BUILD_ID')),'Build the admin console first (npm run admin:build)');
  const bounded=(url,init={})=>fetch(url,{...init,signal:init.signal??AbortSignal.timeout(20000)});
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:bounded}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(r,message)=>{assert.ok(!r.error,message);return r.data;};
  const inventory=()=>sql(`select jsonb_build_object('users',(select jsonb_agg(id order by id) from auth.users),'venues',(select jsonb_agg(id order by id) from public.venues),
    'owners',(select jsonb_agg(venue_id::text||user_id::text order by venue_id,user_id) from private.venue_owners),
    'roles',(select jsonb_agg(user_id::text||role::text order by user_id,role) from private.account_roles),
    'submissions',(select jsonb_agg(id order by id) from private.venue_submissions),'claims',(select jsonb_agg(id order by id) from private.venue_claims),
    'allocations',(select jsonb_agg(id order by id) from private.court_allocations),'sessions',(select jsonb_agg(id order by id) from private.open_play_sessions),
    'groups',(select jsonb_agg(id order by id) from private.session_bookings),'reports',(select jsonb_agg(id order by id) from private.venue_reports),
    'deletions',(select jsonb_agg(user_id order by user_id) from private.account_deletions),
    'audit',jsonb_build_array((select count(*) from private.directory_audit_events),(select count(*) from private.ownership_audit_events),(select count(*) from private.moderation_audit_events)),
    'objects',(select jsonb_agg(bucket_id||'/'||name order by bucket_id,name) from storage.objects where bucket_id in ('owner-evidence','avatars','venue-photos')));`);
  const beforeInventory=inventory();
  const users={},emails={},tokens={},clients={};const venues=new Set();const messages=new Set();
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-acceptance-'));let edgeChild,consoleChild;let stage='startup';
  try{
    // Accounts: owner Olivia adds a venue; Rex owns another listing; players Pia and Paolo; console admin and moderator (trusted bootstrap SQL).
    stage='accounts';
    for(const who of ['olivia','rex','pia','paolo','admin','moderator']){
      emails[who]=`acceptance-${who}-${randomUUID()}@example.invalid`;const password=`Local-${randomUUID()}!`;
      users[who]=check(await service.auth.admin.createUser({email:emails[who],password,email_confirm:true}),'Own account').user.id;
      clients[who]=createClient(api.href,config.ANON_KEY,options);
      tokens[who]=check(await clients[who].auth.signInWithPassword({email:emails[who],password}),'Own login').session.access_token;
    }
    sql(`insert into private.account_roles(user_id,role) values('${users.admin}','admin'),('${users.moderator}','moderator');`);
    // A random Sulu Sea area keeps discovery and duplicate checks to this run's own listings.
    const lat=Number((6+Math.random()).toFixed(4)),lng=Number((120.5+Math.random()).toFixed(4));const tag=randomUUID().slice(0,8);
    const rivalVenue=randomUUID();venues.add(rivalVenue);
    sql(`insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
      values('${rivalVenue}','Acceptance Rival ${tag}','Rival road','Acceptance City','Acceptance',${lat},${lng},'approved','verified');
      insert into public.courts(venue_id,name) values('${rivalVenue}','Rival court');insert into private.venue_owners(user_id,venue_id) values('${users.rex}','${rivalVenue}');`);
    // The real guard over an in-memory limiter: every Node-hosted command reaches it with its verified principal and action.
    const guarded=[];
    const guard=createRateGuard({identifier:async principal=>`${principal.kind}:${principal.id}`,backend:async(action,principal)=>{
      guarded.push(`${action}:${principal.kind}:${principal.id}`);const limit=RATE_POLICIES[action][principal.kind];
      return {success:true,limit,remaining:limit-1,reset:Date.now()+60000};
    }});
    const limit=(action,principal)=>guard(action,principal);const verifier=()=>anon;const server=()=>createClient(api.href,config.SERVICE_ROLE_KEY,options);
    const fns=Object.fromEntries(['owner-submissions','owner-venues','owner-schedules','owner-sessions','rental-bookings','session-bookings','venue-reports'].map(name=>[name,edge(name)]));
    const handlers={
      'owner-submissions':fns['owner-submissions'].handler.createOwnerHandler({...fns['owner-submissions'].deps.createSupabaseOwnerDeps(verifier,server),limit,geocode:null,newId:randomUUID}),
      'owner-venues':fns['owner-venues'].handler.createVenueHandler({...fns['owner-venues'].deps.createSupabaseVenueDeps(verifier,server),limit,newId:randomUUID}),
      'owner-schedules':fns['owner-schedules'].handler.createScheduleHandler({...fns['owner-schedules'].deps.createSupabaseScheduleDeps(verifier,server),limit}),
      'owner-sessions':fns['owner-sessions'].handler.createSessionHandler({...fns['owner-sessions'].deps.createSupabaseSessionDeps(verifier,server),limit}),
      'rental-bookings':fns['rental-bookings'].handler.createRentalHandler({...fns['rental-bookings'].deps.createSupabaseRentalDeps(verifier,server),limit}),
      'session-bookings':fns['session-bookings'].handler.createSessionBookingHandler({...fns['session-bookings'].deps.createSupabaseSessionBookingDeps(verifier,server),limit}),
      'venue-reports':fns['venue-reports'].handler.createVenueReportHandler({...fns['venue-reports'].deps.createSupabaseReportDeps(verifier,server),limit}),
    };
    const local=(name,who)=>({endpoint:`https://acceptance.local/functions/v1/${name}`,apiKey:config.ANON_KEY,accessToken:async()=>tokens[who]??null,
      fetch:(url,init)=>handlers[name](new Request(url,init)),photoPart:()=>new Blob([JPEG]),evidencePart:()=>new Blob([JPEG])});
    const served=(name,who)=>({endpoint:new URL(`functions/v1/${name}`,api).href,apiKey:config.ANON_KEY,accessToken:async()=>who?tokens[who]:null,fetch:(url,init)=>bounded(url,init)});
    const desks=who=>({rental:local('rental-bookings',who),group:local('session-bookings',who)});
    const refused=(outcome,reason,message)=>{assert.equal(outcome.ok,false,message);assert.deepEqual(outcome.failure,{kind:'rejected',reason,retryAfterSeconds:null},message);};
    const day=new Date(Date.now()+8*3600e3+2*86400e3).toISOString().slice(0,10);const at=m=>new Date(Date.parse(`${day}T00:00:00+08:00`)+m*60000).toISOString();

    // Serve every actual pinned Deno Edge function with Redis deliberately absent. A killed Windows `functions serve` leaves its container running; wait for a fresh one.
    stage='served Edge';
    const envPath=path.join(temp,'functions.env');
    fs.writeFileSync(envPath,`DISCOVERY_SUPABASE_URL=http://kong:8000\nDISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}\nDISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}\nDISCOVERY_IP_SOURCE=unknown\nPICKLY_ENV=local\n`,{mode:0o600});
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    edgeChild=spawn(cli,['functions','serve','--env-file',envPath],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    edgeChild.stdout.on('data',()=>{});edgeChild.stderr.on('data',()=>{});let launchError=false;edgeChild.on('error',()=>{launchError=true;});
    let ready=false;
    for(let n=0;n<120&&!ready;n++){
      assert.ok(!launchError&&edgeChild.exitCode===null,'Own Edge server running');
      try{const current=edgeId();ready=Boolean(current)&&current!==staleEdge&&(await bounded(served('account-deletion',null).endpoint,
        {method:'POST',headers:{apikey:config.ANON_KEY,'content-type':'application/json'},body:'{}'})).status===401;}catch{}
      if(!ready)await delay(500);
    }
    assert.ok(ready,'Fresh served Edge ready');

    // The production admin console on its own port, signed in through real email codes.
    stage='production console';
    const origin='http://127.0.0.1:3100';
    const reservation=net.createServer();
    await new Promise((resolve,reject)=>{reservation.once('error',reject);reservation.listen(3100,'127.0.0.1',resolve);});await new Promise(resolve=>reservation.close(resolve));
    consoleChild=spawn(process.execPath,[require.resolve('next/dist/bin/next',{paths:[path.join(root,'apps/admin')]}),'start','--hostname','127.0.0.1','--port','3100'],{
      cwd:path.join(root,'apps/admin'),windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',ADMIN_ORIGIN:origin,ADMIN_SUPABASE_URL:api.origin,
        ADMIN_SUPABASE_PUBLISHABLE_KEY:config.ANON_KEY,ADMIN_SUPABASE_SECRET_KEY:config.SERVICE_ROLE_KEY}});
    consoleChild.stdout.on('data',()=>{});consoleChild.stderr.on('data',()=>{});
    const request=async(route,jar=new Map(),body,headers={})=>{
      const response=await bounded(new URL(route,origin),{method:body===undefined?'GET':'POST',redirect:'manual',
        headers:{Cookie:[...jar].map(([key,value])=>`${key}=${value}`).join('; '),...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...headers},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      for(const cookie of response.headers.getSetCookie()){
        const pair=cookie.split(';')[0];const split=pair.indexOf('=');const name=pair.slice(0,split),value=pair.slice(split+1);
        if(!value||/Max-Age=0/i.test(cookie))jar.delete(name);else jar.set(name,value);
      }
      return response;
    };
    const readCode=async email=>{
      for(let n=0;n<30;n++){
        const page=await (await bounded(new URL('/api/v1/messages?limit=200',inbox))).json();
        const item=page.messages.find(message=>message.To.some(to=>to.Address===email));
        if(item){
          messages.add(item.ID);const message=await (await bounded(new URL(`/api/v1/message/${item.ID}`,inbox))).json();
          const code=message.HTML.match(/>\s*(\d{6})\s*</)?.[1];assert.ok(code,'Local code template');return code;
        }
        await delay(200);
      }
      assert.fail('Local verification email received');
    };
    const signIn=async who=>{
      const jar=new Map();assert.equal((await request('/api/auth/request',jar,{email:emails[who]})).status,200,'Console code request');
      assert.equal((await request('/api/auth/verify',jar,{email:emails[who],code:await readCode(emails[who])})).status,200,'Console code sign-in');return jar;
    };
    let started=false;
    for(let n=0;n<60&&!started;n++){if(consoleChild.exitCode!==null)break;try{started=(await request('/login')).status===200;}catch{}if(!started)await delay(250);}
    assert.ok(started,'Production console started');

    // 1. Guest discovery: only published listings, through the shipped client and served venue-search (Redis absent, so bounded and degraded).
    stage='guest discovery';
    const area={bounds:{south:lat-0.05,west:lng-0.05,north:lat+0.05,east:lng+0.05},city:null,name:null,indoor:null,covered:null,surface:null};
    const discover=async()=>{
      const found=await searchVenues(served('venue-search',null),area);assert.equal(found.ok,true,'Served guest search');
      return found.page.venues.map(v=>[v.id,v.claim_status,v.active_court_count]).sort((a,b)=>a[0].localeCompare(b[0]));
    };
    assert.deepEqual(await discover(),[[rivalVenue,'verified',1]],'Guests find only the published listing');
    assert.deepEqual((await loadVenueDetail(anon,rivalVenue)).courts.map(c=>c.name),['Rival court'],'Guests read its public courts');
    console.log('PASS: guest discovery: the shipped search client over served venue-search (Redis absent) finds only the published listing; public detail lists its courts.');

    // 2. An owner adds their venue: a private draft with proof that only its creator can open and set up.
    stage='owner adds a venue';
    const venueName=`Acceptance Courts ${tag}`;
    const added=await submitOwner(local('owner-submissions','olivia'),{kind:'venue',request_id:randomUUID(),note:null,acknowledge_duplicates:false,
      venue:{name:venueName,address_line:'Acceptance road',city:'Acceptance City',province:'Acceptance',latitude:Number((lat+0.02).toFixed(5)),longitude:lng,court_count:2}},
      {uri:'file:///proof.jpg',name:'proof.jpg',type:'image/jpeg',size:JPEG.length});
    assert.ok(added.ok&&added.value.status==='created','Owner submits the venue with proof');
    const venue=added.value.submission.venue_id;const submission=added.value.submission.id;venues.add(venue);
    const listing=()=>sql(`select publication_status||':'||claim_status from public.venues where id='${venue}'`);
    const access=async who=>{const a=check(await clients[who].rpc('my_account_access'),'Own access')[0];return [a.privileged_roles,a.owned_venue_ids,a.pending_venue_ids];};
    assert.equal(listing(),'draft:pending');assert.deepEqual(await access('olivia'),[[],[],[venue]],'The draft is pending, never owned');
    assert.equal(check(await anon.from('venues').select('id').eq('id',venue),'Public read').length,0,'No public read of a draft');
    assert.deepEqual(await discover(),[[rivalVenue,'verified',1]],'Drafts stay out of discovery');
    for(const who of ['rex','paolo'])refused(await venueClient.loadOwnedVenue(local('owner-venues',who),venue),'not_owner',`${who} cannot open the draft`);
    const drafted=await venueClient.loadOwnedVenue(local('owner-venues','olivia'),venue);assert.equal(drafted.ok,true,'The creator opens the draft');
    const saved=await venueClient.saveOwnedVenue(local('owner-venues','olivia'),{kind:'save',venue_id:venue,expected_updated_at:drafted.value.updated_at,
      venue:{name:venueName,address_line:'1 Acceptance road',city:'Acceptance City',province:'Acceptance'},
      courts:drafted.value.courts.map((court,i)=>({id:court.id,name:`Court ${'AB'[i]}`,surface:'hard',is_indoor:i===0,is_covered:true,status:'active'}))});
    assert.equal(saved.ok,true,'The creator names the courts');
    const courtA=saved.value.courts.find(c=>c.name==='Court A').id,courtB=saved.value.courts.find(c=>c.name==='Court B').id;
    // 06:00-22:00 daily: PHP 400/hour until 17:00, PHP 600/hour after.
    const band=(start_minute,end_minute,hourly_centavos)=>({start_minute,end_minute,hourly_centavos});
    const hours={venue_id:venue,expected_revision:null,schedule:{weekly:Array.from({length:7},()=>[{start_minute:360,end_minute:1320,rates:[band(360,1020,40000),band(1020,1320,60000)]}]),exceptions:[]}};
    for(const who of ['rex','paolo'])refused(await calendar.saveVenueSchedule(local('owner-schedules',who),hours),'not_owner',`${who} cannot set the hours`);
    assert.equal((await calendar.saveVenueSchedule(local('owner-schedules','olivia'),hours)).ok,true,'The creator sets hours and rates');
    refused(await venueClient.saveVenuePolicy(local('owner-venues','rex'),{kind:'save_policy',venue_id:venue,expected_revision:'0',policy:{confirmation:'instant',payment:'arrival'}}),
      'not_owner','Another owner cannot set the policy');
    const setPolicy=async confirmation=>{
      const view=await venueClient.loadVenuePolicy(local('owner-venues','olivia'),venue);assert.equal(view.ok,true,'Owner reads the policy');
      const changed=await venueClient.saveVenuePolicy(local('owner-venues','olivia'),{kind:'save_policy',venue_id:venue,expected_revision:view.value.revision,policy:{confirmation,payment:'arrival'}});
      assert.ok(changed.ok&&changed.value.confirmation===confirmation,`Owner saves the ${confirmation} policy`);
    };
    await setPolicy('approval');
    refused(await rental.client.loadQuote(local('rental-bookings','pia'),{court_id:courtA,starts_at:at(600),ends_at:at(690)}),'venue_unavailable','No rentals before review');
    const sessionInput=(court,title)=>({venue_id:venue,request_id:randomUUID(),court_ids:[court],title,starts_at:at(1080),ends_at:at(1200),capacity:4,group_limit:2,price_centavos:25000});
    refused(await sessions.createSession(local('owner-sessions','olivia'),sessionInput(courtB,'Before review')),'not_owner','No sessions before review');
    console.log('PASS: owner pin: the shipped submission client stores proof and a private draft (no public read, search or other-account access); the creator names courts and sets hours/rates and an approval policy; nobody books it before review.');

    // 3. Console review: guests and players are refused, a moderator cannot publish, an admin's approval publishes and links the owner.
    stage='console review';
    const jars={admin:await signIn('admin'),moderator:await signIn('moderator'),paolo:await signIn('paolo')};
    const decide=(jar,decision)=>request('/api/console/ownership/decide',jar,{subject_id:submission,decision,target_venue_id:null,rejection_reason:null});
    const guestPage=await request('/console/ownership');
    assert.ok([303,307].includes(guestPage.status)&&guestPage.headers.get('location')==='/login','Guests are sent to sign-in');
    assert.equal((await decide(new Map(),'approve')).status,401,'Guest decision denied');
    const playerPage=await (await request('/console/ownership',jars.paolo)).text();
    assert.ok(playerPage.includes('Reviewer access required.')&&!playerPage.includes(venueName),'Players see no review queue');
    assert.equal((await decide(jars.paolo,'approve')).status,403,'Players cannot decide');
    assert.ok((await (await request('/console/ownership',jars.moderator)).text()).includes(venueName),'Moderators see the new venue');
    assert.equal((await decide(jars.moderator,'approve')).status,403,'Moderators cannot publish');assert.equal(listing(),'draft:pending','Nothing published');
    assert.equal((await decide(jars.admin,'approve')).status,200,'The admin approves and publishes');
    assert.equal(listing(),'approved:verified');assert.deepEqual(await access('olivia'),[[],[venue],[]],'The creator now owns the listing');

    // 4. Guests now find the listing and its courts.
    stage='discovery after publication';
    assert.deepEqual(await discover(),[[rivalVenue,'verified',1],[venue,'verified',2]].sort((a,b)=>a[0].localeCompare(b[0])),'Guests find the published venue');
    assert.deepEqual((await loadVenueDetail(anon,venue)).courts.map(c=>c.name).sort(),['Court A','Court B'],'Guests read its courts');
    console.log('PASS: production console review: guest/player refusal, moderator cannot publish, admin approval publishes the draft and links its creator; guests then find it with both courts.');

    // 5. An approval rental: the hold blocks a competing request; only the venue's owner sees and accepts it.
    stage='approval rental';
    const rentals=who=>local('rental-bookings',who);
    const reserve=async(who,court,a,b,transport=rentals(who))=>{
      const quote=await rental.client.loadQuote(rentals(who),{court_id:court,starts_at:at(a),ends_at:at(b)});assert.equal(quote.ok,true,`${who} quote`);
      return {quote:quote.value,result:await rental.client.requestRental(transport,rental.model.reviewedRequest(quote.value,randomUUID()))};
    };
    const first=await reserve('pia',courtA,600,690);
    assert.equal(first.quote.total_centavos,60000,'Server prices 90 minutes at PHP 400/hour');assert.equal(first.quote.policy.confirmation,'approval');
    assert.equal(first.result.ok,true,'The player requests the court');const held=first.result.value.booking;
    assert.equal(held.status,'pending');assert.ok(held.allocation.expires_at,'An approval hold');
    refused((await reserve('paolo',courtA,660,720)).result,'allocation_conflict','A competing request conflicts with the hold');
    for(const who of ['rex','paolo','moderator','admin']){
      refused(await desk.loadRequests(desks(who),'rental',venue,null),'not_owner',`${who} cannot see the venue's requests`);
      refused(await desk.decide(desks(who),'rental',held.id,'accept'),'not_owner',`${who} cannot accept`);
    }
    const queue=await desk.loadRequests(desks('olivia'),'rental',venue,null);assert.equal(queue.ok,true,'Owner request queue');
    assert.deepEqual(queue.value.bookings.map(b=>b.booking.id),[held.id]);
    const accepted=await desk.decide(desks('olivia'),'rental',held.id,'accept');assert.ok(accepted.ok&&accepted.value.booking.booking.status==='confirmed','The owner accepts');
    assert.equal((await rental.client.loadBooking(rentals('pia'),held.id)).value.status,'confirmed','The player sees it confirmed');
    refused(await rental.client.loadBooking(rentals('paolo'),held.id),'not_owner','Other players cannot read it (documented 403)');
    const day1=await calendar.loadCalendar(local('owner-schedules','olivia'),venue,day,1);assert.equal(day1.ok,true,'Owner calendar');
    assert.ok(day1.value.allocations.some(a=>a.id===held.id&&a.kind==='rental'),'The calendar shows the rental');
    refused(await calendar.loadCalendar(local('owner-schedules','rex'),venue,day,1),'not_owner','Another owner cannot read the calendar');
    console.log('PASS: approval rental: exact server price, a hold that blocks a competing request, a request queue and acceptance only for the venue owner (not another owner, player, moderator or admin), private booking reads and the owner calendar.');

    // 6. Instant open play: group limit and capacity hold across players.
    stage='open play';
    await setPolicy('instant');
    refused(await sessions.createSession(local('owner-sessions','rex'),sessionInput(courtB,'Not yours')),'not_owner','Another owner cannot schedule here');
    const created=await sessions.createSession(local('owner-sessions','olivia'),sessionInput(courtB,'Acceptance open play'));
    assert.equal(created.ok,true,'The owner schedules open play');const session=created.value.session.id;
    const groups=who=>local('session-bookings',who);
    const offer=async who=>{const read=await play.client.loadOffer(groups(who),session);assert.equal(read.ok,true,`${who} reads the session`);return read.value;};
    const offers=await play.client.loadOffers(groups('pia'),venue,null);assert.equal(offers.ok,true,'Session list');
    assert.deepEqual(offers.value.sessions.map(s=>[s.id,s.available_spots,s.snapshot.policy.confirmation]),[[session,4,'instant']]);
    let seen=await offer('pia');const preview=play.model.groupPreview(seen.session,seen.at,['Pia','Ana']);
    assert.ok(preview.ok&&preview.total_centavos===50000,'Two names at PHP 250 each');
    const piaGroup=(await play.client.requestGroup(groups('pia'),play.model.groupRequest(seen.session,preview.names,randomUUID()))).value?.booking;
    assert.equal(piaGroup?.status,'confirmed','Instant policy confirms the group');
    seen=await offer('paolo');assert.equal(play.model.groupPreview(seen.session,seen.at,['Paolo','Ben','Cy']).ok,false,'The app explains the group limit');
    refused(await play.client.requestGroup(groups('paolo'),play.model.groupRequest(seen.session,['Paolo','Ben','Cy'],randomUUID())),'group_limit_exceeded','The server enforces the group limit');
    const paoloGroup=(await play.client.requestGroup(groups('paolo'),play.model.groupRequest(seen.session,['Paolo','Ben'],randomUUID()))).value?.booking;
    assert.equal(paoloGroup?.status,'confirmed','A second group fills the session');
    seen=await offer('rex');assert.equal(play.model.offerState(seen.session,seen.at),'full');
    refused(await play.client.requestGroup(groups('rex'),play.model.groupRequest(seen.session,['Rex'],randomUUID())),'session_full','A full session refuses more players');
    refused(await play.client.loadGroupBooking(groups('pia'),paoloGroup.id),'not_owner','Players cannot read other groups (documented 403)');
    console.log('PASS: instant open play: only the venue owner schedules; exact per-person totals; group limit explained by the app and enforced by the server; capacity fills at 4; group records stay private.');

    // 7. Cancellation over served Edge with Redis absent releases inventory; new holds fail closed with no write.
    stage='cancellation with Redis absent';
    const cancelled=await rental.client.cancelRental(served('rental-bookings','pia'),held.id);
    assert.ok(cancelled.ok&&cancelled.value.booking.status==='cancelled','Served cancellation continues without Redis');
    assert.equal((await rental.client.cancelRental(served('rental-bookings','pia'),held.id)).value?.outcome,'existing','Cancellation is retry-safe');
    const outage=await reserve('paolo',courtA,600,690,served('rental-bookings','paolo'));
    assert.equal(outage.result.ok,false);assert.equal(outage.result.failure.kind,'unavailable','New holds fail closed without Redis');
    assert.equal(sql(`select count(*) from private.court_allocations where requested_by='${users.paolo}'`),'0','No write during the outage');
    const rebooked=await reserve('paolo',courtA,600,690);
    assert.ok(rebooked.result.ok&&rebooked.result.value.booking.status==='confirmed','The released court rebooks (instant policy)');const paoloRental=rebooked.result.value.booking;
    const left=await play.client.cancelGroup(served('session-bookings','paolo'),paoloGroup.id);assert.ok(left.ok&&left.value.booking.status==='cancelled','Served group cancellation');
    seen=(await play.client.loadOffer(served('session-bookings','paolo'),session)).value;assert.equal(seen?.session.available_spots,2,'Spots return; served reads continue');
    console.log('PASS: served Edge without Redis: rental and group cancellations succeed once (retry existing) and release inventory that another player rebooks; a new hold fails closed (503) with no write.');

    // 8. A report and a moderator suspension hide the listing and stop new bookings; existing ones stay readable; an admin reinstates.
    stage='report and moderation';
    const report=await reports.submitReport(local('venue-reports','paolo'),reports.reportDraft({requestId:randomUUID(),venueId:venue,reason:'unsafe',details:'Loose net post on Court B'}));
    assert.ok(report.ok&&report.value.outcome==='created','A player reports the listing');
    const moderate=(jar,body)=>request('/api/console/moderation/decide',jar,body);
    const suspend={venue_id:venue,decision:'suspend',reason:'unsafe',report_ids:[report.value.report.id]};
    assert.ok((await (await request('/console/reports',jars.paolo)).text()).includes('Moderator access required.'),'Players see no reports');
    assert.equal((await moderate(jars.paolo,suspend)).status,403,'Players cannot moderate');
    assert.ok((await (await request(`/console/reports/${venue}`,jars.moderator)).text()).includes('Loose net post on Court B'),'The moderator reads the report');
    assert.equal((await moderate(jars.moderator,suspend)).status,200,'The moderator suspends the listing');
    assert.equal(listing(),'suspended:verified');assert.deepEqual(await discover(),[[rivalVenue,'verified',1]],'A suspended listing leaves discovery');
    refused(await rental.client.loadQuote(rentals('pia'),{court_id:courtB,starts_at:at(720),ends_at:at(780)}),'venue_unavailable','No new rentals while suspended');
    refused(await play.client.requestGroup(groups('rex'),play.model.groupRequest(seen.session,['Rex'],randomUUID())),'venue_unavailable','No new groups while suspended');
    assert.equal((await play.client.loadGroupBooking(groups('pia'),piaGroup.id)).value?.status,'confirmed','Existing groups stay readable');
    assert.equal((await rental.client.loadBooking(rentals('paolo'),paoloRental.id)).value?.status,'confirmed','Existing rentals stay readable');
    assert.equal((await moderate(jars.admin,{venue_id:venue,decision:'reinstate',reason:null,report_ids:[]})).status,200,'The admin reinstates');
    assert.equal(listing(),'approved:verified');assert.equal((await discover()).length,2,'Back in discovery');
    console.log('PASS: moderation: a player report, moderator-only suspension in the production console hides the listing and stops new rentals/groups while existing bookings stay readable; admin reinstatement restores it.');

    // 9. Direct API isolation: every service-only RPC, the private schema and direct listing writes are denied to anon and every signed-in role.
    stage='direct API isolation';
    const serviceOnly=JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_array(p.proname,coalesce(to_jsonb(p.proargnames[1:p.pronargs]),'[]'::jsonb)) order by p.proname),'[]')
      from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.prorettype<>'trigger'::regtype
      and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
      and (select count(*) from pg_proc q where q.pronamespace=p.pronamespace and q.proname=p.proname)=1;`));
    for(const name of ['rental_booking_request','session_booking_request','owner_session_create','ownership_review_decide','moderation_decide','account_deletion_begin','directory_search','owner_submit_venue'])
      assert.ok(serviceOnly.some(([n])=>n===name),`${name} is service-only`);
    for(const [who,client] of [['anon',anon],...['olivia','rex','pia','paolo','admin','moderator'].map(who=>[who,clients[who]])]){
      const replies=await Promise.all(serviceOnly.map(([name,args])=>client.rpc(name,Object.fromEntries(args.map(arg=>[arg,null])))));
      replies.forEach((reply,i)=>assert.equal(reply.error?.code,'42501',`${who} cannot call ${serviceOnly[i][0]}`));
      assert.ok((await client.schema('private').from('venue_owners').select('venue_id')).error,`${who} cannot read the private schema`);
      assert.ok((await client.from('venues').insert({name:'Forged',address_line:'Forged',city:'Forged',province:'Forged',latitude:lat,longitude:lng,publication_status:'approved'})).error,`${who} cannot write listings`);
      await client.from('courts').update({name:'Forged'}).eq('venue_id',venue);
    }
    assert.equal(sql(`select string_agg(name,',' order by name) from public.courts where venue_id='${venue}'`),'Court A,Court B','Direct court writes changed nothing');
    assert.deepEqual(await access('rex'),[[],[rivalVenue],[]]);assert.deepEqual(await access('pia'),[[],[],[]]);assert.deepEqual(await access('paolo'),[[],[],[]]);
    assert.deepEqual(await access('admin'),[['admin'],[],[]]);assert.deepEqual(await access('moderator'),[['moderator'],[],[]]);
    const forged=`${tokens.pia.split('.')[0]}.${Buffer.from(JSON.stringify({sub:users.olivia,role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    const guardedBefore=guarded.length;
    for(const name of Object.keys(handlers)){
      // venue-reports is POST-only; the others answer reads.
      const init=name==='venue-reports'?{method:'POST',headers:{authorization:`Bearer ${forged}`,'content-type':'application/json'},body:'{}'}:{headers:{authorization:`Bearer ${forged}`}};
      assert.equal((await handlers[name](new Request(`https://acceptance.local/functions/v1/${name}${init.method?'':`?venue_id=${venue}`}`,init))).status,401,`${name} refuses a forged token`);
    }
    assert.equal(guarded.length,guardedBefore,'Forged tokens never reach the guard');
    const ids=new Set(Object.values(users));
    assert.ok(guarded.every(entry=>{const [,kind,id]=entry.split(':');return kind==='user'&&ids.has(id);}),'Only verified users reach the guard');
    for(const [action,who] of [['owner-submit','olivia'],['owner-edit','olivia'],['hold-create','pia'],['hold-create','paolo'],['report-create','paolo']])
      assert.ok(guarded.includes(`${action}:user:${users[who]}`),`${who} passed the ${action} guard`);
    console.log(`PASS: direct API isolation: ${serviceOnly.length} service-only RPCs return 42501 for anon and all six signed-in roles; private schema and direct listing/court writes denied; account access matches each role; forged tokens get 401 from all seven handlers before the guard; ${guarded.length} guarded commands carried verified user principals.`);

    // 10. A player's account deletion over served Edge cancels their upcoming group and erases names, leaving everyone else's bookings.
    stage='account deletion';
    const gone=await deletion.deleteAccount(served('account-deletion','pia'));assert.ok(gone.ok&&gone.value.status==='deleted','The player deletes their account');
    assert.ok((await service.auth.admin.getUserById(users.pia)).error,'The Auth user is gone');
    assert.equal(sql(`select status||':'||participants::text from private.session_bookings where id='${piaGroup.id}'`),'cancelled:["Guest 1", "Guest 2"]','Group cancelled, names erased');
    assert.equal((await rental.client.loadBooking(rentals('paolo'),paoloRental.id)).value?.status,'confirmed','Other bookings stay');
    assert.equal(listing(),'approved:verified');assert.equal((await offer('paolo')).session.available_spots,4,'Spots return');
    assert.equal((await rental.client.loadHistory(served('rental-bookings','pia'),null)).failure?.kind,'sign_in','The deleted account token is refused');
    console.log('PASS: account deletion over served Edge: the Auth user is gone, the upcoming group is cancelled with names erased and its spots released; the other player\'s rental and the venue are untouched; the old token gets 401.');
  }catch(error){
    if(process.env.PICKLY_DEBUG)console.error(error);
    // Fixed stage labels and our own assertion messages only: no emails, codes, tokens or SDK errors.
    const detail=error?.code==='ERR_ASSERTION'&&error.generatedMessage===false?` (${error.message})`:'';
    throw new Error(`Local acceptance failed at: ${stage}${detail}.`);
  }finally{
    const steps=[];
    for(const child of [edgeChild,consoleChild])if(child&&child.exitCode===null)steps.push(async()=>{child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000);});});
    // Evidence has no cascade; the deleted player's folders were already emptied by deletion.
    steps.push(async()=>{for(const id of Object.values(users)){
      const files=check(await service.storage.from('owner-evidence').list(id),'Evidence list');
      if(files.length)check(await service.storage.from('owner-evidence').remove(files.map(file=>`${id}/${file.name}`)),'Evidence removal');
    }});
    // Users first, so submissions cascade before their venues go; then venues cascade inventory, sessions, groups and reports.
    for(const id of Object.values(users))steps.push(async()=>{const r=await service.auth.admin.deleteUser(id);assert.ok(!r.error||r.error.status===404,'Own account cleanup');});
    steps.push(()=>{
      const people=Object.values(users).map(id=>`'${id}'`).join(',')||'null';const places=[...venues].map(id=>`'${id}'`).join(',')||'null';
      sql(`delete from public.venues where id in (${places});delete from private.directory_audit_events where actor_user_id in (${people}) or target_venue_id in (${places});
        delete from private.ownership_audit_events where actor_user_id in (${people});delete from private.moderation_audit_events where actor_user_id in (${people}) or target_venue_id in (${places});
        delete from private.account_deletions where user_id in (${people});`);
    });
    steps.push(async()=>{if(messages.size)assert.ok((await bounded(new URL('/api/v1/messages',inbox),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({IDs:[...messages]})})).ok);});
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-acceptance-/);fs.rmSync(temp,{recursive:true,force:true});});
    let clean=true;for(const step of steps)try{await step();}catch{clean=false;}
    assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing IDs preserved');
  }
  console.log('PASS: own accounts, venues, evidence, inventory, audits, deletion records, mail and temp env removed; servers stopped; pre-existing IDs preserved; no hosted changes.');
}
main().catch(error=>{
  console.error(/^Local acceptance failed at:/.test(error?.message??'')?error.message:`Local acceptance cleanup failed${error?.code==='ERR_ASSERTION'?` (${error.message})`:''}. Check local Supabase, the admin build and Edge setup.`);
  if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;
});
