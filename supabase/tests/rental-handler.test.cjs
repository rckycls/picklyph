const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('./load-ts.cjs');
const { createRentalHandler, RentalRejected } = load(require('node:path').join(__dirname,'../functions/rental-bookings/handler.ts'), {}, { TextDecoder });
const { createRateGuard } = load(require('node:path').join(__dirname,'../functions/_shared/rate-limit.ts'));
const id='b1000000-0000-4000-8000-000000000001';
const body={kind:'request',court_id:id,request_id:id,starts_at:'2026-10-09T08:00:00+08:00',ends_at:'2026-10-09T09:00:00+08:00',
  expected_quote:{total_centavos:40000,schedule_revision:'1',court_hours_revision:null,policy_revision:'0'}};
const allowed={allowed:true,status:200,state:'enforced',headers:{}};
const base=()=>({verifyUser:async token=>token==='valid'?id:null,limit:async()=>allowed,read:async()=>({bookings:[]}),command:async()=>({outcome:'created'})});
const post=(command=body,headers={})=>new Request('https://rental.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json',...headers},body:JSON.stringify(command)});
test('rental HTTP derives actor, selects action buckets and rejects forged identity/authority',async()=>{
  const seen=[];const deps=base();deps.limit=async(action,p)=>{seen.push(action);assert.equal(p.id,id);return allowed;};
  deps.command=async(actor,c)=>{assert.equal(actor,id);return {kind:c.kind};};const handler=createRentalHandler(deps);
  assert.equal((await handler(post(body,{authorization:'Bearer forged'}))).status,401);
  for(const extra of ['actor_user_id','price','policy','expires_at']) assert.equal((await handler(post({...body,[extra]:id}))).status,400);
  const response=await handler(post());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  for(const kind of ['accept','decline','cancel','expire']) assert.equal((await handler(post({kind,booking_id:id}))).status,200);
  assert.equal((await handler(new Request('https://rental.local?section=history',{headers:{authorization:'Bearer valid'}}))).status,200);
  assert.deepEqual(seen,['hold-create','owner-edit','cancel','cancel','cancel','owner-read']);
});
test('Redis failure, SDK fail-open timeout and deadline block new inventory; release/read remain processable',async()=>{
  let calls=0;const deps=base();deps.command=async()=>{calls++;return {};};
  for(const backend of [async()=>{throw new Error('Outage');},async()=>({success:true,reason:'timeout'}),()=>new Promise(()=>{})]){
    deps.limit=createRateGuard({backend,identifier:async()=>id,timeoutMs:5});const handler=createRentalHandler(deps);
    assert.equal((await handler(post())).status,503);assert.equal(calls,0);
    assert.equal((await handler(post({kind:'accept',booking_id:id}))).status,503);
    for(const kind of ['cancel','decline','expire']) assert.equal((await handler(post({kind,booking_id:id}))).status,200);
    calls=0;
  }
  deps.limit=async()=>({allowed:true,state:'degraded',status:200,headers:{}});
  assert.equal((await createRentalHandler(deps)(post())).status,503);assert.equal(calls,0);
  deps.limit=async()=>{throw new Error('Unexpected limiter failure');};
  assert.equal((await createRentalHandler(deps)(post({kind:'cancel',booking_id:id}))).status,200);
  deps.limit=async()=>({allowed:false,status:429,state:'enforced',headers:{'Retry-After':'17'}});
  const denied=await createRentalHandler(deps)(post());assert.equal(denied.status,429);assert.equal(denied.headers.get('retry-after'),'17');
});
test('rental HTTP bounds streams/queries, maps domain errors and sanitizes infrastructure failures',async()=>{
  const deps=base();const handler=createRentalHandler(deps);
  assert.equal((await handler(post(body,{'content-length':'4097'}))).status,413);
  assert.equal((await handler(new Request('https://rental.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:' '.repeat(4097)}))).status,413);
  assert.equal((await handler(post(body,{'content-type':'text/plain'}))).status,415);
  for(const tail of ['section=history&limit=999','section=history&section=history','section=booking&booking_id=nope'])
    assert.equal((await handler(new Request('https://rental.local?'+tail,{headers:{authorization:'Bearer valid'}}))).status,400);
  for(const [reason,status] of [['stale_quote',409],['not_player',403],['not_owner',403],['booking_not_found',404],['allocation_conflict',409],['venue_unavailable',404]]){
    deps.command=async()=>{throw new RentalRejected(reason);};assert.equal((await createRentalHandler(deps)(post())).status,status);
  }
  deps.command=async()=>{throw new Error('Sensitive database details');};
  const hidden=await createRentalHandler(deps)(post());assert.equal(hidden.status,503);assert.equal(await hidden.text(),'{"error":"temporarily_unavailable"}');
});
test('outside rentals and front desk (T31): entries fail closed on owner-edit; attendance/payment continue on owner-ops',async()=>{
  const path=require('node:path');const handlerModule=load(path.join(__dirname,'../functions/rental-bookings/handler.ts'),{},{TextDecoder});
  const {createSupabaseRentalDeps}=load(path.join(__dirname,'../functions/rental-bookings/deps.ts'),{'./handler.ts':handlerModule});
  const entry={...body,kind:'owner_entry',guest_name:' Wei '};const pay={kind:'record_payment',booking_id:id,method:'ewallet',amount_centavos:40000};
  const seen=[];const calls=[];const deps=base();deps.limit=async action=>{seen.push(action);return allowed;};deps.command=async(actor,c)=>{calls.push(c);return {};};
  const handler=createRentalHandler(deps);
  assert.equal((await handler(post(entry))).status,200);assert.equal(calls[0].guest_name,'Wei');
  for(const kind of ['check_in','no_show','complete']) assert.equal((await handler(post({kind,booking_id:id}))).status,200);
  assert.equal((await handler(post(pay))).status,200);
  assert.equal((await handler(new Request(`https://rental.local?section=day&venue_id=${id}&date=2026-10-09`,{headers:{authorization:'Bearer valid'}}))).status,200);
  assert.deepEqual(seen,['owner-edit','owner-ops','owner-ops','owner-ops','owner-ops','owner-read']);
  for(const bad of [{...entry,guest_name:''},{...entry,guest_name:'x'.repeat(61)},{...entry,guest_name:'A\tB'},{...entry,actor_user_id:id},{...body,guest_name:'Wei'},{...pay,method:'gcash'}])
    assert.equal((await handler(post(bad))).status,400);
  for(const backend of [async()=>{throw new Error('Outage');},async()=>({success:true,reason:'timeout'})]){
    calls.length=0;deps.limit=createRateGuard({backend,identifier:async()=>id,timeoutMs:5});const outage=createRentalHandler(deps);
    assert.equal((await outage(post(entry))).status,503);assert.equal(calls.length,0);
    assert.equal((await outage(post({kind:'check_in',booking_id:id}))).status,200);assert.equal((await outage(post(pay))).status,200);
  }
  for(const reason of ['not_started','payment_recorded','amount_mismatch']){
    deps.limit=async()=>allowed;deps.command=async()=>{throw new RentalRejected(reason);};assert.equal((await createRentalHandler(deps)(post(pay))).status,409);
  }
  const rpc=[];const server=()=>({rpc:async(name,args)=>{rpc.push([name,args]);return {data:{ok:true},error:null};}});
  const supa=createSupabaseRentalDeps(()=>({}),server);const parsed=require('../../packages/domain/src/rentalBooking.ts').readRentalCommand(entry);
  await supa.command(id,parsed);await supa.command(id,pay);await supa.read(id,{section:'day',venue_id:id,date:'2026-10-09',after_id:id});
  assert.deepEqual(JSON.parse(JSON.stringify(rpc)),[['rental_booking_owner_entry',{actor_user_id:id,target_court_id:id,request_id:id,starts:parsed.starts_at,ends:parsed.ends_at,
    guest_name:'Wei',expected_quote:body.expected_quote}],
    ['booking_operation',{actor_user_id:id,target_kind:'rental',target_booking_id:id,command:'record_payment',method:'ewallet',amount:40000}],
    ['booking_operations_read',{actor_user_id:id,target_kind:'rental',target_venue_id:id,target_day:'2026-10-09',after_id:id}]]);
});
