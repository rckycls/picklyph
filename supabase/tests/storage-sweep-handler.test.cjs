const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {test}=require('node:test');const load=require('./load-ts.cjs');
const {createStorageSweepHandler,sweepOnce,SWEEP_BATCH,MAX_ROUNDS,RUN_BUDGET_MS}=load(path.join(__dirname,'../functions/storage-sweep/handler.ts'));
const {createSupabaseStorageSweepDeps}=load(path.join(__dirname,'../functions/storage-sweep/deps.ts'));
const plain=value=>JSON.parse(JSON.stringify(value));
const secret='s'.repeat(40);
const item=(bucket,n,reason='unreferenced')=>({bucket,path:`f/${n}.jpg`,reason});
// A fake worker world: batches handed out in order; Storage removes what it is asked unless a bucket refuses.
function world({batches=[],refuse=[],remaining=()=>0,steps=[],now}={}){
  let next=0;
  return {steps,secret,now,
    due:async(batch)=>{steps.push(['due',batch]);return batches[next++]??{items:[],more:false};},
    remove:async(bucket,paths)=>{steps.push(['remove',bucket,[...paths]]);if(refuse.includes(bucket))throw new Error('Storage refused');return paths.length;},
    confirm:async(items)=>{steps.push(['confirm',items.length]);return {purged:items.filter(i=>i.reason==='evidence_retention').length,remaining:remaining(items)};}};
}
const call=(handler,init={})=>handler(new Request('https://sweep.local',{method:'POST',headers:{authorization:`Bearer ${secret}`},body:'{}',...init}));

test('storage-sweep accepts only its worker secret, and does nothing otherwise',async()=>{
  const steps=[];const handler=createStorageSweepHandler(world({steps}));
  const get=await call(handler,{method:'GET',body:undefined});assert.equal(get.status,405);assert.equal(get.headers.get('allow'),'POST');
  assert.equal((await call(handler,{headers:{}})).status,401);
  assert.equal((await call(handler,{headers:{authorization:'Bearer '+'t'.repeat(40)}})).status,401);
  assert.equal((await call(handler,{headers:{authorization:'Bearer eyJhbGciOiJIUzI1NiJ9.user.token'}})).status,401,'a user token is not the worker secret');
  assert.equal((await call(handler,{headers:{authorization:`Basic ${secret}`}})).status,401);
  for(const patch of [{secret:undefined},{secret:'short'}]){
    const reply=await call(createStorageSweepHandler({...world({steps}),...patch}));assert.equal(reply.status,503);assert.deepEqual(plain(await reply.json()),{error:'not_configured'});
  }
  assert.deepEqual(steps,[],'nothing ran for refused calls');
  const ok=await call(handler);assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(plain(await ok.json()),{due:0,removed:0,purged:0,remaining:0,refused:0,rounds:1,more:false});
  assert.deepEqual(steps,[['due',SWEEP_BATCH]],'an empty run asks once and stops');
});

test('one removal per bucket, in a fixed order, then confirmation of the whole batch',async()=>{
  const batch={items:[item('venue-photos',1),item('owner-evidence',2,'evidence_retention'),item('avatars',3),item('owner-evidence',4),item('venue-photos',5)],more:false};
  const steps=[];const summary=await sweepOnce(world({batches:[batch],steps}));
  assert.deepEqual(steps,[['due',SWEEP_BATCH],['remove','owner-evidence',['f/2.jpg','f/4.jpg']],['remove','venue-photos',['f/1.jpg','f/5.jpg']],['remove','avatars',['f/3.jpg']],['confirm',5]]);
  assert.deepEqual(plain(summary),{due:5,removed:5,purged:1,remaining:0,refused:0,rounds:1,more:false});
});

test('runs continue while more is due and stop at a stuck batch, the round limit or the time budget',async()=>{
  const full=n=>({items:[item('avatars',n)],more:true});
  let steps=[];
  let summary=await sweepOnce(world({batches:[full(1),full(2),{items:[item('avatars',3)],more:false}],steps}));
  assert.equal(summary.rounds,3);assert.equal(summary.due,3);assert.equal(summary.more,false);assert.equal(steps.filter(s=>s[0]==='confirm').length,3);
  // Something still present after removal comes first again: stop instead of asking for it again.
  steps=[];summary=await sweepOnce(world({batches:[full(1),full(2)],remaining:()=>1,steps}));
  assert.equal(summary.rounds,1);assert.equal(summary.remaining,1);assert.equal(summary.more,true);
  steps=[];summary=await sweepOnce(world({batches:Array.from({length:MAX_ROUNDS+5},(_, n)=>full(n)),steps}));
  assert.equal(summary.rounds,MAX_ROUNDS,'bounded rounds');assert.equal(summary.more,true,'a later run continues');
  let clock=0;steps=[];
  summary=await sweepOnce(world({batches:Array.from({length:MAX_ROUNDS},(_, n)=>full(n)),steps,now:()=>{clock+=RUN_BUDGET_MS/2;return clock;}}));
  assert.ok(summary.rounds<MAX_ROUNDS&&summary.rounds>=1,'the budget ends the run early');
});

test('a Storage refusal leaves that bucket for the next run, still confirms the batch and answers 502',async()=>{
  const batch={items:[item('owner-evidence',1,'evidence_retention'),item('avatars',2)],more:true};
  const steps=[];
  const reply=await call(createStorageSweepHandler(world({batches:[batch,batch],refuse:['owner-evidence'],remaining:()=>1,steps})));
  assert.equal(reply.status,502);
  assert.deepEqual(plain(await reply.json()),{error:'storage_refused',due:2,removed:1,purged:1,remaining:1,refused:1,rounds:1,more:true});
  assert.deepEqual(steps.map(s=>s[0]),['due','remove','remove','confirm'],'the other bucket still ran, then the run stopped');
});

test('database trouble answers 503 with Retry-After and removes nothing after it',async()=>{
  for(const broken of [{due:async()=>{throw new Error('down');}},{confirm:async()=>{throw new Error('down');}}]){
    const steps=[];const reply=await call(createStorageSweepHandler({...world({batches:[{items:[item('avatars',1)],more:false}],steps}),...broken}));
    assert.equal(reply.status,503);assert.equal(reply.headers.get('retry-after'),'300');assert.deepEqual(plain(await reply.json()),{error:'temporarily_unavailable'});
  }
});

test('deps: service RPCs with strict replies, and Storage API removal per bucket',async()=>{
  const calls=[];let rpcReply={data:{at:'2026-10-12T00:00:00Z',items:[item('avatars',1)],more:false},error:null};let removeReply={data:[{name:'f/1.jpg'}],error:null};
  const server=()=>({rpc:async(name,args)=>{calls.push(['rpc',name,plain(args)]);return rpcReply;},
    storage:{from:(bucket)=>({remove:async(paths)=>{calls.push(['remove',bucket,paths]);return removeReply;}})}});
  const deps=createSupabaseStorageSweepDeps(server);
  assert.deepEqual(plain(await deps.due(200)),{more:false,items:[item('avatars',1)]});
  assert.equal(await deps.remove('avatars',['f/1.jpg']),1);
  rpcReply={data:{purged:0,remaining:0},error:null};
  assert.deepEqual(plain(await deps.confirm([item('avatars',1)])),{purged:0,remaining:0});
  assert.deepEqual(calls,[['rpc','storage_sweep_due',{batch_limit:200}],['remove','avatars',['f/1.jpg']],['rpc','storage_sweep_confirm',{items:[item('avatars',1)]}]]);
  rpcReply={data:null,error:{message:'denied'}};
  await assert.rejects(deps.due(200),/Storage sweep unavailable/);await assert.rejects(deps.confirm([]),/Storage sweep unavailable/);
  rpcReply={data:{items:[{bucket:'other',path:'x',reason:'unreferenced'}],more:false},error:null};
  await assert.rejects(deps.due(200),/Unexpected storage sweep reply/,'only the three buckets');
  rpcReply={data:{purged:-1,remaining:0},error:null};await assert.rejects(deps.confirm([]),/Unexpected storage sweep reply/);
  removeReply={data:null,error:{message:'storage down'}};await assert.rejects(deps.remove('avatars',['f/1.jpg']),/Storage refused/);
});

test('the function is configured like the other workers and checked with them',()=>{
  const root=path.join(__dirname,'../..');
  const config=fs.readFileSync(path.join(root,'supabase/config.toml'),'utf8');
  assert.match(config,/\[functions\.storage-sweep\]\n#[^\n]*STORAGE_SWEEP_SECRET[^\n]*\nverify_jwt = false\nimport_map = "\.\/functions\/deno\.json"/);
  assert.match(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts['functions:check'],/supabase\/functions\/storage-sweep\/index\.ts/);
  const index=fs.readFileSync(path.join(root,'supabase/functions/storage-sweep/index.ts'),'utf8');
  assert.match(index,/secret: env\('STORAGE_SWEEP_SECRET'\)/);assert.doesNotMatch(index,/PUBLISHABLE|getUser|authorization/i,'never a user token');
});
