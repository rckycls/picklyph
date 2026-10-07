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
const court='63000000-0000-4000-8000-000000000001';const requestId='64000000-0000-4000-8000-000000000001';
const block={kind:'block',court_id:court,request_id:requestId,starts_at:'2026-10-09T08:00:00+08:00',ends_at:'2026-10-09T09:30:00+08:00'};
const hours={kind:'save_court_hours',court_id:court,expected_revision:null,hours:{weekly:null,closures:['2026-10-12']}};
const full=()=>({...base(),calendar:async()=>({courts:[]}),block:async()=>({outcome:'created'}),release:async()=>({outcome:'released'}),saveCourtHours:async()=>({revision:'1'})});
test('calendar reads and inventory commands use the verified actor, owner limits and strict bodies',async()=>{
  const seen=[];const deps=full();deps.limit=async(action,principal)=>{seen.push(action);assert.equal(principal.id,'verified-actor');return {allowed:true,headers:{}};};
  deps.calendar=async(actor,venue,date,days)=>{seen.push([actor,venue,date,days]);return {courts:[]};};
  deps.block=async(actor,c)=>{seen.push([actor,c.court_id,c.starts_at,c.ends_at]);return {outcome:'created'};};
  deps.release=async(actor,allocation)=>{seen.push([actor,allocation]);return {outcome:'released'};};
  deps.saveCourtHours=async(actor,c)=>{seen.push([actor,c.court_id,c.hours.closures]);return {revision:'1'};};
  const handler=createScheduleHandler(deps);
  const get=tail=>handler(new Request('https://schedule.local?'+tail,{headers:{authorization:'Bearer valid'}}));
  assert.equal((await get(`venue_id=${id}&start_date=2026-10-09&days=7&section=calendar`)).status,200);
  for(const tail of [`venue_id=${id}&start_date=2026-10-09&days=8&section=calendar`,`venue_id=${id}&start_date=2026-10-09&days=1&section=other`,
    `venue_id=${id}&start_date=2099-12-30&days=3&section=calendar`,`venue_id=${id}&start_date=2026-10-09&days=1&section=calendar&actor_user_id=${id}`])
    assert.equal((await get(tail)).status,400);
  assert.equal((await handler(request(block))).status,200);
  assert.equal((await handler(request({kind:'release_block',allocation_id:requestId}))).status,200);
  assert.equal((await handler(request(hours))).status,200);
  for(const body of [{...block,actor_user_id:id},{...block,starts_at:'2026-10-09T08:15:00+08:00'},{...block,kind:'rental'},{kind:'release_block',allocation_id:'nope'},
    {kind:'release_block',allocation_id:requestId,court_id:court},{...hours,hours:{weekly:[],closures:[]}},{...hours,hours:{weekly:null,closures:['2026-02-30']}},
    {...command,kind:'save_schedule'}])
    assert.equal((await handler(request(body))).status,400);
  assert.deepEqual(JSON.parse(JSON.stringify(seen)),['owner-read',['verified-actor',id,'2026-10-09',7],'owner-read','owner-read','owner-read','owner-read',
    'owner-edit',['verified-actor',court,'2026-10-09T00:00:00.000Z','2026-10-09T01:30:00.000Z'],'owner-edit',['verified-actor',requestId],
    'owner-edit',['verified-actor',court,['2026-10-12']],...Array(8).fill('owner-edit')]);
});
test('inventory writes fail closed on limiter outage and map inventory refusals',async()=>{
  let blocks=0;const deps=full();deps.block=async()=>{blocks++;};
  deps.limit=async()=>({allowed:false,status:503,headers:{'Retry-After':'5'}});
  const bad=request(block);bad.body.getReader=()=>{throw new Error('Body must not be read');};
  assert.equal((await createScheduleHandler(deps)(bad)).status,503);assert.equal(blocks,0);
  deps.limit=async()=>({allowed:true,headers:{}});
  for(const [reason,status] of [['allocation_conflict',409],['outside_hours',409],['request_reused',409],['court_unavailable',404],['not_owner',403]]){
    deps.block=async()=>{throw new ScheduleRejected(reason);};
    const response=await createScheduleHandler(deps)(request(block));assert.equal(response.status,status);assert.deepEqual(await response.json(),{error:reason});
  }
  deps.release=async()=>{throw new ScheduleRejected('managed_allocation');};
  assert.equal((await createScheduleHandler(deps)(request({kind:'release_block',allocation_id:requestId}))).status,403);
  deps.saveCourtHours=async()=>{throw new ScheduleRejected('hours_conflict');};
  assert.equal((await createScheduleHandler(deps)(request(hours))).status,409);
  deps.save=async()=>{throw new ScheduleRejected('hours_conflict');};
  assert.equal((await createScheduleHandler(deps)(request())).status,409);
  deps.calendar=async()=>{throw new Error('Sensitive infrastructure fixture');};
  const hidden=await createScheduleHandler(deps)(new Request(`https://schedule.local?venue_id=${id}&start_date=2026-10-09&days=1&section=calendar`,{headers:{authorization:'Bearer valid'}}));
  assert.equal(hidden.status,503);assert.equal(await hidden.text(),'{"error":"temporarily_unavailable"}');
});
