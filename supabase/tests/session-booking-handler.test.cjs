const assert=require('node:assert/strict');const path=require('node:path');const {test}=require('node:test');const load=require('./load-ts.cjs');
const domain=require('../../packages/domain/src/sessionBooking.ts');
const handlerModule=load(path.join(__dirname,'../functions/session-bookings/handler.ts'),{},{TextDecoder});
const {createSessionBookingHandler,SessionBookingRejected}=handlerModule;
const {createSupabaseSessionBookingDeps}=load(path.join(__dirname,'../functions/session-bookings/deps.ts'),{'./handler.ts':handlerModule});
const {createRateGuard}=load(path.join(__dirname,'../functions/_shared/rate-limit.ts'));
const id='c6000000-0000-4000-8000-000000000001';
const body={kind:'request',session_id:id,request_id:id,participants:['Ana','Ben'],expected_total_centavos:50000};
const allowed={allowed:true,status:200,state:'enforced',headers:{}};
const base=()=>({verifyUser:async token=>token==='valid'?id:null,limit:async()=>allowed,read:async()=>({bookings:[]}),command:async()=>({outcome:'created'})});
const post=(command=body,headers={})=>new Request('https://groups.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json',...headers},body:JSON.stringify(command)});
const get=tail=>new Request('https://groups.local?'+tail,{headers:{authorization:'Bearer valid'}});
test('group booking HTTP derives the verified actor, selects buckets and rejects forged identity or authority',async()=>{
  const seen=[];const deps=base();deps.limit=async(action,p)=>{seen.push(action);assert.equal(p.id,id);return allowed;};
  deps.command=async(actor,c)=>{assert.equal(actor,id);return {kind:c.kind};};const handler=createSessionBookingHandler(deps);
  assert.equal((await handler(post(body,{authorization:'Bearer forged'}))).status,401);
  assert.equal((await handler(new Request('https://groups.local',{method:'POST',body:'{}'}))).status,401);
  for(const extra of ['actor_user_id','price_centavos','policy','expires_at','status']) assert.equal((await handler(post({...body,[extra]:id}))).status,400);
  const response=await handler(post());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  for(const kind of ['accept','decline','cancel']) assert.equal((await handler(post({kind,booking_id:id}))).status,200);
  assert.equal((await handler(post({kind:'expire',booking_id:id}))).status,400);
  assert.equal((await handler(get(`section=sessions&venue_id=${id}`))).status,200);
  assert.deepEqual(seen,['hold-create','owner-edit','cancel','cancel','owner-read']);
  assert.equal((await handler(new Request('https://groups.local',{method:'PUT',headers:{authorization:'Bearer valid'}}))).status,405);
});
test('Redis failure, SDK fail-open timeout and deadline block new groups/acceptance; decline, cancel and reads continue',async()=>{
  let calls=0;const deps=base();deps.command=async()=>{calls++;return {};};
  for(const backend of [async()=>{throw new Error('Outage');},async()=>({success:true,reason:'timeout'}),()=>new Promise(()=>{})]){
    deps.limit=createRateGuard({backend,identifier:async()=>id,timeoutMs:5});const handler=createSessionBookingHandler(deps);
    assert.equal((await handler(post())).status,503);assert.equal((await handler(post({kind:'accept',booking_id:id}))).status,503);assert.equal(calls,0);
    for(const kind of ['cancel','decline']) assert.equal((await handler(post({kind,booking_id:id}))).status,200);
    assert.equal((await handler(get('section=history'))).status,200);calls=0;
  }
  deps.limit=async()=>({allowed:true,state:'degraded',status:200,headers:{}});
  assert.equal((await createSessionBookingHandler(deps)(post())).status,503);assert.equal(calls,0);
  deps.limit=async()=>{throw new Error('Unexpected limiter failure');};
  assert.equal((await createSessionBookingHandler(deps)(post({kind:'cancel',booking_id:id}))).status,200);
  deps.limit=async()=>({allowed:false,status:429,state:'enforced',headers:{'Retry-After':'17'}});
  const denied=await createSessionBookingHandler(deps)(post());assert.equal(denied.status,429);assert.equal(denied.headers.get('retry-after'),'17');
});
test('group booking HTTP bounds a full named group, maps refusals and sanitizes infrastructure failures',async()=>{
  const deps=base();const handler=createSessionBookingHandler(deps);
  const group={...body,participants:Array.from({length:200},(_,i)=>`Player ${String(i).padStart(3,'0')} ${'x'.repeat(40)}`)};
  assert.ok(JSON.stringify(group).length<=domain.MAX_SESSION_BOOKING_BYTES);assert.equal((await handler(post(group))).status,200);
  assert.equal((await handler(post(body,{'content-length':String(domain.MAX_SESSION_BOOKING_BYTES+1)}))).status,413);
  assert.equal((await handler(new Request('https://groups.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},
    body:' '.repeat(domain.MAX_SESSION_BOOKING_BYTES+1)}))).status,413);
  assert.equal((await handler(post(body,{'content-type':'text/plain'}))).status,415);
  assert.equal((await handler(new Request('https://groups.local?x=1',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:JSON.stringify(body)}))).status,400);
  for(const tail of ['section=history&limit=999','section=history&section=history','section=booking&booking_id=nope','section=sessions','section=roster&session_id='+id])
    assert.equal((await handler(get(tail))).status,400);
  for(const [reason,status] of [['session_full',409],['group_limit_exceeded',409],['already_booked',409],['stale_quote',409],['session_cancelled',409],
    ['session_started',409],['arrival_unavailable',409],['request_reused',409],['not_player',403],['not_owner',403],['player_required',403],
    ['booking_not_found',404],['session_not_found',404],['venue_unavailable',404],['invalid_input',400]]){
    deps.command=async()=>{throw new SessionBookingRejected(reason);};assert.equal((await createSessionBookingHandler(deps)(post())).status,status);
  }
  deps.command=async()=>{throw new Error('Sensitive database details');};
  const hidden=await createSessionBookingHandler(deps)(post());assert.equal(hidden.status,503);assert.equal(await hidden.text(),'{"error":"temporarily_unavailable"}');
});
test('Supabase deps send only the derived actor and normalized body; unknown database errors stay sanitized',async()=>{
  const calls=[];const reply={data:{ok:true},error:null};
  const server=()=>({rpc:async(name,args)=>{calls.push([name,args]);return reply;}});
  const deps=createSupabaseSessionBookingDeps(()=>({auth:{getUser:async()=>({data:{user:{id}},error:null})}}),server);
  await deps.command(id,domain.readSessionBookingCommand({...body,participants:[' Ana ','Ben']}));
  await deps.command(id,{kind:'cancel',booking_id:id});
  await deps.read(id,{section:'sessions',venue_id:id,after_id:null});await deps.read(id,{section:'history',after_id:id});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['session_booking_request',{actor_user_id:id,booking_input:{session_id:id,request_id:id,participants:['Ana','Ben'],expected_total_centavos:50000}}],
    ['session_booking_change',{actor_user_id:id,target_booking_id:id,command:'cancel'}],
    ['session_booking_read',{actor_user_id:id,section:'sessions',target_id:id,after_id:null}],
    ['session_booking_read',{actor_user_id:id,section:'history',target_id:null,after_id:id}]]);
  reply.data=null;reply.error={code:'23514',hint:'session_full'};
  await assert.rejects(deps.command(id,{kind:'cancel',booking_id:id}),e=>e instanceof SessionBookingRejected&&e.reason==='session_full');
  reply.error={code:'XX000',hint:'secret detail'};await assert.rejects(deps.command(id,{kind:'cancel',booking_id:id}),e=>!(e instanceof SessionBookingRejected));
  const failing=createSupabaseSessionBookingDeps(()=>({auth:{getUser:async()=>({data:{user:null},error:{status:500}})}}),server);
  await assert.rejects(failing.verifyUser('token'));
});
