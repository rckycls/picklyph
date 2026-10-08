const assert=require('node:assert/strict');const path=require('node:path');const {test}=require('node:test');const load=require('./load-ts.cjs');
const {createSessionHandler,SessionRejected}=load(path.join(__dirname,'../functions/owner-sessions/handler.ts'),{},{TextDecoder});
const {createRateGuard}=load(path.join(__dirname,'../functions/_shared/rate-limit.ts'));
const id='c5000000-0000-4000-8000-000000000001';
const body={kind:'create',venue_id:id,request_id:id,court_ids:[id],title:'Open play',starts_at:'2026-10-09T18:00:00+08:00',ends_at:'2026-10-09T20:00:00+08:00',capacity:12,group_limit:4,price_centavos:25000};
const allowed={allowed:true,status:200,state:'enforced',headers:{}};
const base=()=>({verifyUser:async token=>token==='valid'?id:null,limit:async()=>allowed,read:async()=>({sessions:[]}),command:async()=>({outcome:'created'})});
const post=(command=body,headers={})=>new Request('https://sessions.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json',...headers},body:JSON.stringify(command)});
test('sessions derive verified actor, reject forged authority and bound body/query with sanitized errors',async()=>{
  const seen=[];const deps=base();deps.limit=async(action,principal)=>{seen.push(action);assert.equal(principal.id,id);return allowed;};
  deps.command=async(actor)=>{assert.equal(actor,id);return {};};const handler=createSessionHandler(deps);
  assert.equal((await handler(post(body,{authorization:'Bearer forged'}))).status,401);
  for(const key of ['actor_user_id','policy','expires_at']) assert.equal((await handler(post({...body,[key]:id}))).status,400);
  const response=await handler(post());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.equal((await handler(post({kind:'cancel',session_id:id}))).status,200);
  assert.equal((await handler(new Request(`https://sessions.local?venue_id=${id}`,{headers:{authorization:'Bearer valid'}}))).status,200);
  assert.deepEqual(seen,['hold-create','cancel','owner-read']);
  assert.equal((await handler(post(body,{'content-length':'4097'}))).status,413);
  assert.equal((await handler(new Request('https://sessions.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:' '.repeat(4097)}))).status,413);
  assert.equal((await handler(post(body,{'content-type':'text/plain'}))).status,415);
  for(const [reason,status] of [['not_owner',403],['allocation_conflict',409],['session_has_bookings',409],['session_not_found',404]]){
    deps.command=async()=>{throw new SessionRejected(reason);};assert.equal((await createSessionHandler(deps)(post())).status,status);
  }
  deps.command=async()=>{throw new Error('Sensitive details');};assert.equal(await (await createSessionHandler(deps)(post())).text(),'{"error":"temporarily_unavailable"}');
});
test('Redis outage, timeout and degraded allowances cannot create sessions; cancellation/read continue',async()=>{
  let writes=0;const deps=base();deps.command=async()=>{writes++;return {};};
  for(const backend of [async()=>{throw new Error('outage');},async()=>({success:true,reason:'timeout'}),()=>new Promise(()=>{})]){
    deps.limit=createRateGuard({backend,identifier:async()=>id,timeoutMs:5});const handler=createSessionHandler(deps);
    assert.equal((await handler(post())).status,503);assert.equal(writes,0);
    assert.equal((await handler(post({kind:'cancel',session_id:id}))).status,200);writes=0;
    assert.equal((await handler(new Request(`https://sessions.local?venue_id=${id}`,{headers:{authorization:'Bearer valid'}}))).status,200);
  }
  deps.limit=async()=>({allowed:true,status:200,state:'degraded',headers:{}});assert.equal((await createSessionHandler(deps)(post())).status,503);assert.equal(writes,0);
  deps.limit=async()=>{throw new Error('Unexpected failure');};assert.equal((await createSessionHandler(deps)(post({kind:'cancel',session_id:id}))).status,200);
  deps.limit=async()=>({allowed:false,status:429,state:'enforced',headers:{'Retry-After':'17'}});
  assert.equal((await createSessionHandler(deps)(post())).headers.get('retry-after'),'17');
});
