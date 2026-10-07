const assert = require('node:assert/strict');
const { test } = require('node:test');
const load = require('./load-ts.cjs');
const { createScheduleHandler, ScheduleRejected } = load(require('node:path').join(__dirname,'../functions/owner-schedules/handler.ts'), {}, { TextDecoder });
const id='62000000-0000-4000-8000-000000000001';
const command={venue_id:id,expected_revision:null,schedule:{weekly:Array.from({length:7},()=>[]),exceptions:[]}};
const request=(body=command,headers={})=>new Request('https://schedule.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json',...headers},body:JSON.stringify(body)});
const base=()=>({verifyUser:async token=>token==='valid'?'verified-actor':null,limit:async()=>({allowed:true,headers:{}}),read:async()=>({revision:null}),save:async()=>({revision:'1'})});
test('schedule HTTP verifies identity, derives actor and rejects authority input',async()=>{
  let actor; const deps=base(); deps.save=async a=>{actor=a;return {revision:'1'};}; const handler=createScheduleHandler(deps);
  assert.equal((await handler(request(command,{authorization:'Bearer forged'}))).status,401);
  const response=await handler(request());assert.equal(response.status,200);assert.equal(actor,'verified-actor');
  assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.equal((await handler(request({...command,actor_user_id:id}))).status,400);
});
test('schedule writes fail closed on limiter outage before reading body; 429 retry headers survive',async()=>{
  let saves=0;const deps=base();deps.save=async()=>{saves++;};
  deps.limit=async()=>({allowed:false,status:503,headers:{'Retry-After':'5'}});
  const bad=request();bad.body.getReader=()=>{throw new Error('Body must not be read');};
  assert.equal((await createScheduleHandler(deps)(bad)).status,503);assert.equal(saves,0);
  deps.limit=async()=>({allowed:false,status:429,headers:{'Retry-After':'22'}});
  const limited=await createScheduleHandler(deps)(request());assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'22');
});
test('schedule body is stream-bounded and query/date ranges are strict',async()=>{
  const handler=createScheduleHandler(base());
  assert.equal((await handler(request(command,{'content-length':'300000'}))).status,413);
  assert.equal((await handler(new Request('https://schedule.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:' '.repeat(262145)}))).status,413);
  for(const tail of ['venue_id='+id+'&start_date=2026-02-30&days=1','venue_id='+id+'&start_date=2026-10-05&days=32','venue_id='+id+'&venue_id='+id+'&start_date=2026-10-05&days=1'])
    assert.equal((await handler(new Request('https://schedule.local?'+tail,{headers:{authorization:'Bearer valid'}}))).status,400);
  assert.equal((await handler(new Request('https://schedule.local?venue_id='+id+'&start_date=2026-10-05&days=1',{headers:{authorization:'Bearer valid'}}))).status,200);
});
test('schedule conflicts/permissions are actionable and unknown infrastructure errors are sanitized',async()=>{
  const deps=base();deps.save=async()=>{throw new ScheduleRejected('version_conflict');};
  assert.equal((await createScheduleHandler(deps)(request())).status,409);
  deps.save=async()=>{throw new ScheduleRejected('not_owner');};assert.equal((await createScheduleHandler(deps)(request())).status,403);
  deps.save=async()=>{throw new Error('Sensitive infrastructure fixture');};const response=await createScheduleHandler(deps)(request());
  assert.equal(response.status,503);assert.equal(await response.text(),'{"error":"temporarily_unavailable"}');
});
