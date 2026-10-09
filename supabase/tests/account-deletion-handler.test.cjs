const assert=require('node:assert/strict');const path=require('node:path');const {test}=require('node:test');const load=require('./load-ts.cjs');
const handlerModule=load(path.join(__dirname,'../functions/account-deletion/handler.ts'),{},{TextDecoder});
const {createAccountDeletionHandler,DeletionRejected,DELETION_STATUS,DELETION_BUCKETS}=handlerModule;
const {createSupabaseAccountDeletionDeps}=load(path.join(__dirname,'../functions/account-deletion/deps.ts'),{'./handler.ts':handlerModule},{TextDecoder,atob});
const {createRateGuard}=load(path.join(__dirname,'../functions/_shared/rate-limit.ts'));
const id='c4780000-0000-4000-8000-000000000001';
const body={confirm:'delete_account'};
const allowed={allowed:true,status:200,state:'enforced',headers:{'X-RateLimit-Remaining':'4'}};
// Records every dependency call in order, so tests can prove the Auth user is deleted last.
const base=(steps=[])=>({steps,verifyUser:async token=>token==='valid'?{kind:'user',id}:token==='gone'?{kind:'missing',id}:null,limit:async()=>allowed,
  begin:async actor=>{steps.push(`begin:${actor}`);return {outcome:'started'};},status:async user=>{steps.push(`status:${user}`);return 'deleted';},
  removeFolder:async(bucket,folder)=>{steps.push(`remove:${bucket}/${folder}`);},deleteUser:async actor=>{steps.push(`delete:${actor}`);}});
const post=(input=body,headers={})=>new Request('https://deletion.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json',...headers},
  body:typeof input==='string'?input:JSON.stringify(input)});
test('deletion HTTP takes the verified actor, needs the exact confirmation body and deletes the Auth user only after its files',async()=>{
  const deps=base();const seen=[];deps.limit=async(action,p)=>{seen.push(action);assert.deepEqual(JSON.parse(JSON.stringify(p)),{kind:'user',id});return allowed;};
  const handler=createAccountDeletionHandler(deps);
  assert.equal((await handler(post(body,{authorization:'Bearer forged'}))).status,401);
  assert.equal((await handler(new Request('https://deletion.local',{method:'POST',body:'{}'}))).status,401);
  assert.equal((await handler(new Request('https://deletion.local',{headers:{authorization:'Bearer valid'}}))).status,405);
  assert.equal((await handler(new Request('https://deletion.local?user=x',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:JSON.stringify(body)}))).status,400);
  assert.equal((await handler(post(body,{'content-type':'text/plain'}))).status,415);
  for(const input of [{},{confirm:'DELETE'},{confirm:'delete_account',actor_user_id:id},{confirm:'delete_account',user_id:id},[],'null','"delete_account"','{nope'])
    assert.equal((await handler(post(input))).status,400,JSON.stringify(input));
  assert.equal((await handler(post(body,{'content-length':'99999'}))).status,413);
  assert.equal((await handler(post(JSON.stringify({confirm:'delete_account',pad:'x'.repeat(500)})))).status,413);
  assert.deepEqual(deps.steps,[]);
  const response=await handler(post());assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'deleted'});
  assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-ratelimit-remaining'),'4');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.deepEqual(deps.steps,[`begin:${id}`,`remove:avatars/${id}`,`remove:owner-evidence/${id}`,`delete:${id}`]);
  assert.deepEqual([...DELETION_BUCKETS],['avatars','owner-evidence']);assert.deepEqual(seen,['account-delete']);
});
test('any failure before the last step is a retryable 503 that leaves the Auth user; console accounts get a stable 403',async()=>{
  for(const failing of ['begin','removeFolder','deleteUser']){
    const deps=base();const original=deps[failing];let calls=0;
    deps[failing]=async(...args)=>{calls++;if(failing!=='removeFolder'||args[0]==='owner-evidence')throw new Error('down');return original(...args);};
    const response=await createAccountDeletionHandler(deps)(post());
    assert.equal(response.status,503,failing);assert.equal(response.headers.get('retry-after'),'5');assert.ok(calls>0);
    assert.ok(!deps.steps.some(step=>step.startsWith('delete:')),`${failing}: no Auth deletion after a failure`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(DELETION_STATUS)),{privileged_account:403});
  const deps=base();deps.begin=async()=>{throw new DeletionRejected('privileged_account');};
  const refused=await createAccountDeletionHandler(deps)(post());assert.equal(refused.status,403);assert.deepEqual(await refused.json(),{error:'privileged_account'});
  assert.deepEqual(deps.steps,[]);
  const unknown=base();unknown.begin=async()=>{throw new DeletionRejected('account_required');};assert.equal((await createAccountDeletionHandler(unknown)(post())).status,503);
  const auth=base();auth.verifyUser=async()=>{throw new Error('Auth down');};assert.equal((await createAccountDeletionHandler(auth)(post())).status,503);
});
test('deletion keeps working when Redis is down (like cancellation) but honours an enforced 429',async()=>{
  for(const backend of [async()=>{throw new Error('Outage');},async()=>({success:true,reason:'timeout'}),()=>new Promise(()=>{})]){
    const deps=base();deps.limit=createRateGuard({backend,identifier:async()=>id,timeoutMs:5});
    const response=await createAccountDeletionHandler(deps)(post());assert.equal(response.status,200);assert.equal(deps.steps.at(-1),`delete:${id}`);
  }
  const deps=base();deps.limit=createRateGuard({backend:async()=>({success:false,limit:5,remaining:0,reset:Date.now()+30000}),identifier:async()=>id,now:Date.now});
  const limited=await createAccountDeletionHandler(deps)(post());assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('retry-after'))>0);
  assert.deepEqual(deps.steps,[]);
  const broken=base();broken.limit=async()=>{throw new Error('Guard bug');};assert.equal((await createAccountDeletionHandler(broken)(post())).status,503);
});
test('a retry whose token outlived the account is confirmed only from a deletion that started here',async()=>{
  const gone=post(body,{authorization:'Bearer gone'});
  for(const [status,expected] of [['deleted',200],['pending',401],['none',401]]){
    const deps=base();deps.status=async user=>{deps.steps.push(`status:${user}`);return status;};
    const response=await createAccountDeletionHandler(deps)(gone.clone());assert.equal(response.status,expected,status);
    assert.deepEqual(deps.steps,[`status:${id}`],'no new deletion work for a missing account');
  }
  const failing=base();failing.status=async()=>{throw new Error('down');};assert.equal((await createAccountDeletionHandler(failing)(gone.clone())).status,503);
  assert.equal((await createAccountDeletionHandler(base())(post({confirm:'nope'},{authorization:'Bearer gone'}))).status,400,'the body is still checked');
});
test('Supabase deps: Auth user_not_found yields the verified token subject; storage folders are emptied page by page; a 404 Auth delete is done',async()=>{
  const payload=Buffer.from(JSON.stringify({sub:id.toUpperCase(),role:'authenticated'})).toString('base64url');const token=`h.${payload}.s`;
  const verifier=()=>({auth:{getUser:async jwt=>jwt==='good'?{data:{user:{id}},error:null}
    :jwt===token?{data:{user:null},error:{status:403,code:'user_not_found'}}
    :jwt==='h.bm90LWpzb24.s'?{data:{user:null},error:{status:403,code:'user_not_found'}}
    :{data:{user:null},error:{status:jwt==='down'?500:jwt==='expired'?403:401,code:jwt==='expired'?'bad_jwt':undefined}}}});
  const rpcCalls=[];let reply={data:{outcome:'started'},error:null};const listed=[];const removed=[];let pages=[[{name:'a.jpg'},{name:'b.png'}],[{name:'c.jpg'}],[]];let deleteError=null;
  const server=()=>({rpc:async(name,args)=>{rpcCalls.push([name,args]);return reply;},
    storage:{from:bucket=>({list:async(folder,options)=>{listed.push([bucket,folder,options.limit]);return {data:pages.shift()??[],error:null};},
      remove:async paths=>{removed.push(paths);return {data:[],error:null};}})},
    auth:{admin:{deleteUser:async user=>{rpcCalls.push(['deleteUser',user]);return {error:deleteError};}}}});
  const real=createSupabaseAccountDeletionDeps(verifier,server);
  assert.deepEqual(JSON.parse(JSON.stringify(await real.verifyUser('good'))),{kind:'user',id});
  assert.deepEqual(JSON.parse(JSON.stringify(await real.verifyUser(token))),{kind:'missing',id},'subject read only after Auth verified the token');
  assert.equal(await real.verifyUser('h.bm90LWpzb24.s'),null);assert.equal(await real.verifyUser('expired'),null);assert.equal(await real.verifyUser('bad'),null);
  await assert.rejects(real.verifyUser('down'));
  assert.deepEqual(await real.begin(id),{outcome:'started'});
  reply={data:null,error:{code:'42501',hint:'privileged_account'}};await assert.rejects(real.begin(id),e=>e instanceof DeletionRejected&&e.reason==='privileged_account');
  reply={data:null,error:{code:'P0002',hint:'account_required'}};await assert.rejects(real.begin(id),e=>!(e instanceof DeletionRejected));
  reply={data:'deleted',error:null};assert.equal(await real.status(id),'deleted');
  reply={data:'gone',error:null};await assert.rejects(real.status(id));
  await real.removeFolder('avatars',id);
  assert.deepEqual(JSON.parse(JSON.stringify(listed)),[['avatars',id,100],['avatars',id,100],['avatars',id,100]]);
  assert.deepEqual(JSON.parse(JSON.stringify(removed)),[[`${id}/a.jpg`,`${id}/b.png`],[`${id}/c.jpg`]]);
  pages=[];await real.removeFolder('owner-evidence',id);assert.equal(removed.length,2,'an empty folder removes nothing');
  await real.deleteUser(id);deleteError={status:404};await real.deleteUser(id);deleteError={status:500};await assert.rejects(real.deleteUser(id));
  assert.deepEqual(JSON.parse(JSON.stringify(rpcCalls.filter(c=>c[0]!=='deleteUser'))),[['account_deletion_begin',{actor_user_id:id}],['account_deletion_begin',{actor_user_id:id}],
    ['account_deletion_begin',{actor_user_id:id}],['account_deletion_status',{target_user_id:id}],['account_deletion_status',{target_user_id:id}]]);
});
