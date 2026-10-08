const assert=require('node:assert/strict');const path=require('node:path');const {test}=require('node:test');const load=require('./load-ts.cjs');
const handlerModule=load(path.join(__dirname,'../functions/venue-reports/handler.ts'),{},{TextDecoder});
const {createVenueReportHandler,ReportRejected,REPORT_STATUS}=handlerModule;
const {createSupabaseReportDeps}=load(path.join(__dirname,'../functions/venue-reports/deps.ts'),{'./handler.ts':handlerModule});
const {createRateGuard}=load(path.join(__dirname,'../functions/_shared/rate-limit.ts'));
const id='c4680000-0000-4000-8000-000000000001';
const body={request_id:id,venue_id:id,reason:'closed',details:'Gates locked\nsince May'};
const allowed={allowed:true,status:200,state:'enforced',headers:{'X-RateLimit-Remaining':'4'}};
const base=()=>({verifyUser:async token=>token==='valid'?id:null,limit:async()=>allowed,submit:async(actor,report)=>({outcome:'created',report:{...report,id}})});
const post=(input=body,headers={})=>new Request('https://reports.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json',...headers},
  body:typeof input==='string'?input:JSON.stringify(input)});
test('report HTTP derives the verified actor, uses the report-create bucket and rejects forged identity or authority',async()=>{
  const seen=[];const sent=[];const deps=base();deps.limit=async(action,p)=>{seen.push(action);assert.deepEqual(JSON.parse(JSON.stringify(p)),{kind:'user',id});return allowed;};
  deps.submit=async(actor,report)=>{sent.push([actor,report]);return {outcome:'created'};};const handler=createVenueReportHandler(deps);
  assert.equal((await handler(post(body,{authorization:'Bearer forged'}))).status,401);
  assert.equal((await handler(new Request('https://reports.local',{method:'POST',body:'{}'}))).status,401);
  assert.equal((await handler(new Request('https://reports.local',{headers:{authorization:'Bearer valid'}}))).status,405);
  assert.equal((await handler(new Request('https://reports.local?venue_id=x',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:JSON.stringify(body)}))).status,400);
  assert.equal((await handler(post(body,{'content-type':'text/plain'}))).status,415);
  for(const extra of ['actor_user_id','reporter_user_id','status','id']) assert.equal((await handler(post({...body,[extra]:id}))).status,400);
  for(const details of ['',' padded','crlf\r\nline','x'.repeat(501),7]) assert.equal((await handler(post({...body,details}))).status,400);
  assert.equal((await handler(post({...body,reason:'rude'}))).status,400);assert.equal((await handler(post('{nope'))).status,400);
  assert.equal((await handler(post(body,{'content-length':'99999'}))).status,413);
  assert.equal((await handler(post(JSON.stringify({...body,details:'x'.repeat(5000)})))).status,413);
  assert.equal(sent.length,0);
  const response=await handler(post());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(response.headers.get('x-ratelimit-remaining'),'4');assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)),[[id,body]]);assert.deepEqual(seen,['report-create']);
});
test('Redis failure, SDK fail-open timeout, deadline and degraded allowances stop reports before the database',async()=>{
  let calls=0;const deps=base();deps.submit=async()=>{calls++;return {};};
  for(const backend of [async()=>{throw new Error('Outage');},async()=>({success:true,reason:'timeout'}),()=>new Promise(()=>{})]){
    deps.limit=createRateGuard({backend,identifier:async()=>id,timeoutMs:5});
    const response=await createVenueReportHandler(deps)(post());assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'5');
  }
  deps.limit=async()=>({allowed:true,state:'degraded',status:200,headers:{}});assert.equal((await createVenueReportHandler(deps)(post())).status,503);
  deps.limit=async()=>{throw new Error('Guard bug');};assert.equal((await createVenueReportHandler(deps)(post())).status,503);
  deps.limit=createRateGuard({backend:async()=>({success:false,limit:5,remaining:0,reset:Date.now()+30000}),identifier:async()=>id,now:Date.now});
  const limited=await createVenueReportHandler(deps)(post());assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);
  assert.equal(calls,0);
  const auth=base();auth.verifyUser=async()=>{throw new Error('Auth down');};assert.equal((await createVenueReportHandler(auth)(post())).status,503);
});
test('database refusals map to stable statuses; anything else is an uncertain 503',async()=>{
  assert.deepEqual(JSON.parse(JSON.stringify(REPORT_STATUS)),{invalid_input:400,account_required:403,venue_unavailable:404,already_reported:409,request_reused:409,too_many_reports:409});
  for(const [hint,status] of Object.entries(REPORT_STATUS)){
    const deps=base();deps.submit=async()=>{throw new ReportRejected(hint);};const response=await createVenueReportHandler(deps)(post());
    assert.equal(response.status,status);assert.deepEqual(await response.json(),{error:hint});
  }
  const deps=base();deps.submit=async()=>{throw new Error('socket hang up');};assert.equal((await createVenueReportHandler(deps)(post())).status,503);
  // The deps translate only known hints; the actor is passed to the RPC from verified Auth, never the body.
  const rpcCalls=[];let reply={data:{outcome:'created'},error:null};
  const server=()=>({rpc:async(name,args)=>{rpcCalls.push([name,args]);return reply;}});
  const verifier=()=>({auth:{getUser:async token=>token==='good'?{data:{user:{id}},error:null}:{data:{user:null},error:{status:token==='down'?500:401}}}});
  const real=createSupabaseReportDeps(verifier,server);
  assert.equal(await real.verifyUser('good'),id);assert.equal(await real.verifyUser('bad'),null);await assert.rejects(real.verifyUser('down'));
  assert.deepEqual(await real.submit(id,body),{outcome:'created'});assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls)),[['venue_report_submit',{actor_user_id:id,report_input:body}]]);
  reply={data:null,error:{code:'23505',hint:'already_reported'}};await assert.rejects(real.submit(id,body),e=>e instanceof ReportRejected&&e.reason==='already_reported');
  reply={data:null,error:{code:'42883',hint:null}};await assert.rejects(real.submit(id,body),e=>!(e instanceof ReportRejected));
});
