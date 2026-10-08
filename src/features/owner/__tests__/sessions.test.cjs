const assert=require('node:assert/strict');const {test}=require('node:test');const path=require('node:path');
const load=require('../../../../supabase/tests/load-ts.cjs');
const domain={...require('../../../../packages/domain/src/session.ts'),...require('../../../../packages/domain/src/booking.ts'),...require('../../../../packages/domain/src/money.ts'),
  ...require('../../../../packages/domain/src/calendar.ts'),...require('../../../../packages/domain/src/schedule.ts')};
const here=path.dirname(module.filename);const imports={'@picklyph/domain':domain};
imports['./calendarModel']=load(path.join(here,'../calendarModel.ts'),imports,{Intl});
imports['./calendarClient']=load(path.join(here,'../calendarClient.ts'),{...imports,'./venueClient':require('../venueClient.ts')});
const {sessionDraft}=load(path.join(here,'../sessionDraft.ts'),imports);
const {createSessionJournal}=load(path.join(here,'../sessionAttempt.ts'),imports);
const client=load(path.join(here,'../sessionClient.ts'),{...imports,'./venueClient':require('../venueClient.ts')});
const id='c5000000-0000-4000-8000-000000000001';const other='c5000000-0000-4000-8000-000000000002';
const plain=value=>JSON.parse(JSON.stringify(value));
const command=()=>sessionDraft({venueId:id,requestId:id,courts:[id],title:'Open play',date:'2026-10-09',start:1080,end:1440,capacity:'12',group:'4',price:'250.50'});
const session=()=>({id,venue_id:id,status:'scheduled',created_at:'2026-10-08T00:00:00Z',cancelled_at:null,reserved_spots:0,
  snapshot:{...command(),currency:'PHP',timezone:'Asia/Manila',policy:{confirmation:'instant',payment:'arrival',merchant_active:false},policy_revision:'0',schedule_revision:'1',
    court_hours_revisions:[{court_id:id,revision:null}],approval_hold_minutes:120,payment_hold_minutes:15,refund_cutoff_hours:24},
  allocations:[{id,venue_id:id,court_id:id,kind:'session',starts_at:command().starts_at,ends_at:command().ends_at,expires_at:null,state:'active',ended_at:null}]});
test('session draft converts 18:00 and next midnight using civil time; strict responses reject cross-venue/court authority',()=>{
  assert.equal(command().starts_at,'2026-10-09T10:00:00.000Z');assert.equal(command().ends_at,'2026-10-09T16:00:00.000Z');assert.equal(command().price_centavos,25050);
  assert.equal(sessionDraft({venueId:id,requestId:id,courts:[id],title:'Night play',date:'2026-10-09',start:1320,end:1560,capacity:'12',group:'4',price:'250'}).ends_at,'2026-10-09T18:00:00.000Z');
  const parsed=client.parseSession(session());assert.equal(parsed.snapshot.capacity,12);
  for(const delta of [{reserved_spots:13},{status:'cancelled'},{snapshot:{...session().snapshot,price_centavos:0.5}},
    {allocations:[{...session().allocations[0],venue_id:other}]},{allocations:[{...session().allocations[0],court_id:other}]},
    {snapshot:{...session().snapshot,court_hours_revisions:[{court_id:other,revision:null}]}}]) assert.throws(()=>client.parseSession({...session(),...delta}));
});
test('session journal persists before dispatch and recovers the original body after a lost reply or restart',async()=>{
  const values=new Map();const store={get:async key=>values.get(key)??null,set:async(key,value)=>values.set(key,value),remove:async key=>values.delete(key)};
  const first=createSessionJournal(store,'one');
  const failed=await first.run(command(),async original=>{assert.deepEqual(plain(await first.read()),plain(original));return {ok:false,failure:{kind:'network',retryAfterSeconds:null}};});assert.equal(failed.ok,false);
  const restarted=createSessionJournal(store,'one');assert.deepEqual(plain(await restarted.read()),plain(command()));
  await assert.rejects(restarted.run({...command(),capacity:10},async()=>{throw new Error('must not send');}));
  assert.equal(await createSessionJournal(store,'other-account').read(),null);
  await restarted.run(command(),async()=>({ok:true,value:{outcome:'existing',session:client.parseSession(session())}}));assert.equal(await restarted.read(),null);
  const broken=createSessionJournal({...store,set:async()=>{throw new Error('storage');}},'broken');let dispatched=false;
  await assert.rejects(broken.run(command(),async()=>{dispatched=true;}));assert.equal(dispatched,false);
});
test('session client keeps malformed successes uncertain and checks creation/cancellation identity',async()=>{
  let reply={outcome:'created',session:session()};let sent;
  const transport={endpoint:'https://sessions.local',apiKey:'public',accessToken:async()=>'token',fetch:async(_url,init)=>{sent=JSON.parse(init.body);return new Response(JSON.stringify(reply));}};
  assert.equal((await client.createSession(transport,command())).ok,true);assert.equal(sent.kind,'create');assert.equal(sent.actor_user_id,undefined);
  reply={outcome:'created',session:{...session(),venue_id:other}};assert.equal((await client.createSession(transport,command())).failure.kind,'unavailable');
  reply={outcome:'existing',session:{...session(),status:'cancelled',cancelled_at:'2026-10-08T01:00:00Z',allocations:[{...session().allocations[0],state:'released',ended_at:'2026-10-08T01:00:00Z'}]}};
  assert.equal((await client.cancelSession(transport,id)).ok,true);assert.equal((await client.cancelSession(transport,other)).failure.kind,'unavailable');
});
test('session recovery serializes taps and retains uncertain auth/rate/outage/reused replies',async()=>{
  const values=new Map();const store={get:async key=>values.get(key)??null,set:async(key,value)=>values.set(key,value),remove:async key=>values.delete(key)};
  const journal=createSessionJournal(store,'owner');let resolve;
  const first=journal.run(command(),()=>new Promise(done=>{resolve=done;}));
  // Let durable storage finish before the mocked network request pauses.
  while(!resolve)await new Promise(done=>setTimeout(done,0));
  await assert.rejects(journal.run(command(),async()=>{throw new Error('Duplicate tap dispatched');}));
  resolve({ok:false,failure:{kind:'network',retryAfterSeconds:null}});await first;
  for(const failure of [{kind:'sign_in',retryAfterSeconds:null},{kind:'rate_limited',retryAfterSeconds:17},
    {kind:'unavailable',retryAfterSeconds:5},{kind:'rejected',reason:'request_reused',retryAfterSeconds:null}]){
    await journal.run(command(),async()=>({ok:false,failure}));assert.notEqual(await journal.read(),null);
  }
  await journal.run(command(),async()=>({ok:false,failure:{kind:'rejected',reason:'allocation_conflict',retryAfterSeconds:null}}));
  assert.equal(await journal.read(),null);
});
