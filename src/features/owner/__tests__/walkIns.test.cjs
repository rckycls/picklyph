const assert=require('node:assert/strict');const {test}=require('node:test');const path=require('node:path');
const load=require('../../../../supabase/tests/load-ts.cjs');
const domain={...require('../../../../packages/domain/src/sessionBooking.ts'),...require('../../../../packages/domain/src/booking.ts')};
const here=path.dirname(module.filename);
const client=load(path.join(here,'../walkInClient.ts'),{'@picklyph/domain':domain,'./venueClient':require('../venueClient.ts')});
const id='c5100000-0000-4000-8000-000000000001';const other='c5100000-0000-4000-8000-000000000002';const venue='c5100000-0000-4000-8000-000000000003';
const plain=value=>JSON.parse(JSON.stringify(value));
const command=()=>client.walkInDraft({sessionId:id,requestId:id,names:' Ana \n\nBen\r\nCy ',priceCentavos:25000});
const booking=(delta={})=>({id:other,session_id:id,source:'walk_in',status:'confirmed',payment_method:'arrival',payment_status:'unpaid',
  participants:['Ana','Ben','Cy'],spots:3,expires_at:null,created_at:'2026-10-10T02:00:00.123456+00:00',updated_at:'2026-10-10T02:00:00.123456+00:00',
  snapshot:{venue_id:venue,title:'Open play',court_ids:[venue],starts_at:'2026-10-10T10:00:00+00:00',ends_at:'2026-10-10T12:00:00+00:00',
    price_centavos:25000,spots:3,total_centavos:75000,currency:'PHP',timezone:'Asia/Manila',policy:{confirmation:'instant',payment:'arrival',merchant_active:false},
    policy_revision:'0',approval_hold_minutes:120,payment_hold_minutes:15,refund_cutoff_hours:24},...delta});
test('walk-in draft takes one trimmed name per line, prices the group and rejects repeated or long names',()=>{
  assert.deepEqual(plain(command()),{kind:'walk_in',session_id:id,request_id:id,participants:['Ana','Ben','Cy'],expected_total_centavos:75000});
  assert.deepEqual(plain(client.walkInNames('\n  \n')),[]);
  for(const names of ['','Ana\nana',`${'a'.repeat(61)}`]) assert.throws(()=>client.walkInDraft({sessionId:id,requestId:id,names,priceCentavos:25000}));
});
test('walk-in responses are strict: names, totals, source and hold state must agree',()=>{
  const parsed=client.parseSessionBooking(booking());assert.equal(parsed.created_at,'2026-10-10T02:00:00.123Z');assert.equal(parsed.snapshot.total_centavos,75000);
  for(const delta of [{source:'admin'},{status:'pending',expires_at:'2026-10-10T03:00:00Z'},{expires_at:'2026-10-10T03:00:00Z'},{spots:2},
    {participants:['Ana','ana','Cy']},{payment_status:'paid'},{snapshot:{...booking().snapshot,total_centavos:70000}},
    {snapshot:{...booking().snapshot,spots:2}},{created_at:'2026-10-10 02:00'}]) assert.throws(()=>client.parseSessionBooking(booking(delta)));
  assert.equal(client.parseSessionBooking(booking({source:'player',status:'pending',expires_at:'2026-10-10T03:00:00Z'})).status,'pending');
});
test('walk-in client sends no caller authority and treats mismatched successes as uncertain',async()=>{
  let reply={outcome:'created',booking:booking()};let sent;let url;
  const transport={endpoint:'https://groups.local',apiKey:'public',accessToken:async()=>'token',fetch:async(u,init)=>{url=u;sent=init.body?JSON.parse(init.body):null;return new Response(JSON.stringify(reply));}};
  assert.equal((await client.addWalkIn(transport,command())).ok,true);assert.deepEqual(sent,plain(command()));
  for(const b of [booking({source:'player'}),booking({session_id:venue}),booking({participants:['Ana','Cy','Ben']})]){
    reply={outcome:'existing',booking:b};assert.equal((await client.addWalkIn(transport,command())).failure.kind,'unavailable');
  }
  reply={outcome:'changed',booking:booking()};assert.equal((await client.addWalkIn(transport,command())).failure.kind,'unavailable');
  reply={outcome:'changed',booking:booking({status:'cancelled'})};
  assert.equal((await client.removeWalkIn(transport,other)).ok,true);assert.deepEqual(sent,{kind:'cancel',booking_id:other});
  assert.equal((await client.removeWalkIn(transport,id)).failure.kind,'unavailable');
  reply={bookings:[booking()],next_cursor:null};const page=await client.listWalkIns(transport,id);assert.equal(page.ok,true);
  assert.equal(new URL(url).searchParams.get('section'),'walk_ins');assert.equal(new URL(url).searchParams.get('session_id'),id);
  for(const bookings of [[booking({source:'player'})],[booking({session_id:venue})]]){
    reply={bookings,next_cursor:null};assert.equal((await client.listWalkIns(transport,id)).failure.kind,'unavailable');
  }
  reply={error:'session_full'};transport.fetch=async()=>new Response(JSON.stringify(reply),{status:409});
  const full=await client.addWalkIn(transport,command());assert.deepEqual(plain(full.failure),{kind:'rejected',reason:'session_full',retryAfterSeconds:null});
  assert.match(client.walkInFailureMessage(full.failure),/spots/);
});
test('walk-in journal saves before dispatch, survives restart, serializes taps and keeps uncertain replies',async()=>{
  const values=new Map();const store={get:async key=>values.get(key)??null,set:async(key,value)=>values.set(key,value),remove:async key=>values.delete(key)};
  const first=client.createWalkInJournal(store,'owner');let resolve;
  const running=first.run(command(),async original=>{assert.deepEqual(plain(await first.read()),plain(original));return new Promise(done=>{resolve=done;});});
  while(!resolve)await new Promise(done=>setTimeout(done,0));
  await assert.rejects(first.run(command(),async()=>{throw new Error('Duplicate tap dispatched');}));
  resolve({ok:false,failure:{kind:'network',retryAfterSeconds:null}});await running;
  const restarted=client.createWalkInJournal(store,'owner');assert.deepEqual(plain(await restarted.read()),plain(command()));
  await assert.rejects(restarted.run({...command(),participants:['Ana'],expected_total_centavos:25000},async()=>{throw new Error('must not send');}));
  assert.equal(await client.createWalkInJournal(store,'other-account').read(),null);
  for(const failure of [{kind:'sign_in',retryAfterSeconds:null},{kind:'rate_limited',retryAfterSeconds:17},
    {kind:'unavailable',retryAfterSeconds:5},{kind:'rejected',reason:'request_reused',retryAfterSeconds:null}]){
    await restarted.run(command(),async()=>({ok:false,failure}));assert.notEqual(await restarted.read(),null);
  }
  await restarted.run(command(),async()=>({ok:false,failure:{kind:'rejected',reason:'session_full',retryAfterSeconds:null}}));
  assert.equal(await restarted.read(),null);
  await restarted.run(command(),async()=>({ok:true,value:{outcome:'existing',booking:client.parseSessionBooking(booking())}}));assert.equal(await restarted.read(),null);
  const broken=client.createWalkInJournal({...store,set:async()=>{throw new Error('storage');}},'broken');let dispatched=false;
  await assert.rejects(broken.run(command(),async()=>{dispatched=true;}));assert.equal(dispatched,false);
});
