const assert=require('node:assert/strict');const path=require('node:path');const {test}=require('node:test');const load=require('./load-ts.cjs');
const devicesModule=load(path.join(__dirname,'../functions/push-devices/handler.ts'),{},{TextDecoder});
const {createPushDevicesHandler,PushDeviceRejected,PUSH_DEVICE_STATUS}=devicesModule;
const {createSupabasePushDeviceDeps}=load(path.join(__dirname,'../functions/push-devices/deps.ts'),{'./handler.ts':devicesModule},{TextDecoder});
const expoModule=load(path.join(__dirname,'../functions/push-dispatch/expo.ts'),{},{TextDecoder});
const dispatchModule=load(path.join(__dirname,'../functions/push-dispatch/handler.ts'),{'./expo.ts':expoModule},{TextDecoder,Intl});
const {createPushDispatchHandler,dispatchOnce,PUSH_BATCH,LEASE_SECONDS,RUN_BUDGET_MS}=dispatchModule;
const {readPushClaim}=load(path.join(__dirname,'../functions/push-dispatch/deps.ts'),{},{TextDecoder});
const {createRateGuard}=load(path.join(__dirname,'../functions/_shared/rate-limit.ts'));
const plain=value=>JSON.parse(JSON.stringify(value));
const id='c4310000-0000-4000-8000-000000000001';const token='ExponentPushToken[abcDEF123-_]';
const allowed={allowed:true,status:200,state:'enforced',headers:{'X-RateLimit-Remaining':'9'}};
const base=(steps=[])=>({steps,verifyUser:async t=>t==='valid'?id:null,limit:async()=>allowed,
  register:async(actor,command)=>{steps.push(['register',actor,plain(command)]);},unregister:async(actor,command)=>{steps.push(['unregister',actor,plain(command)]);}});
const post=(input,headers={})=>new Request('https://push.local',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json',...headers},
  body:typeof input==='string'?input:JSON.stringify(input)});

test('push-devices takes the verified actor and a strict body, registers or removes, and never names an account',async()=>{
  const deps=base();const seen=[];deps.limit=async(action,p)=>{seen.push([action,plain(p)]);return allowed;};
  const handler=createPushDevicesHandler(deps);
  assert.equal((await handler(post({kind:'register',token,platform:'ios'},{authorization:'Bearer forged'}))).status,401);
  assert.equal((await handler(new Request('https://push.local',{method:'POST',body:'{}'}))).status,401);
  assert.equal((await handler(new Request('https://push.local',{headers:{authorization:'Bearer valid'}}))).status,405);
  assert.equal((await handler(new Request('https://push.local?user=x',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},
    body:JSON.stringify({kind:'register',token,platform:'ios'})}))).status,400);
  assert.equal((await handler(post({kind:'register',token,platform:'ios'},{'content-type':'text/plain'}))).status,415);
  for(const input of [{},{kind:'register',token},{kind:'register',token,platform:'web'},{kind:'register',token,platform:'ios',user_id:id},
    {kind:'register',token:'ExponentPushToken[]',platform:'ios'},{kind:'register',token:'ExponentPushToken[a b]',platform:'ios'},{kind:'register',token:'abc',platform:'ios'},
    {kind:'unregister',token,platform:'ios'},{kind:'unregister'},{kind:'delete',token},[],'null','{nope'])
    assert.equal((await handler(post(input))).status,400,JSON.stringify(input));
  assert.equal((await handler(post({kind:'register',token,platform:'ios'},{'content-length':'99999'}))).status,413);
  assert.equal((await handler(post(JSON.stringify({kind:'register',token,platform:'ios',pad:'x'.repeat(1100)})))).status,413);
  assert.deepEqual(deps.steps,[]);
  const registered=await handler(post({kind:'register',token,platform:'ios'}));
  assert.equal(registered.status,200);assert.deepEqual(await registered.json(),{status:'registered'});
  assert.equal(registered.headers.get('cache-control'),'private, no-store');assert.equal(registered.headers.get('x-ratelimit-remaining'),'9');
  const removed=await handler(post({kind:'unregister',token:'ExpoPushToken[xyz]'}));assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{status:'removed'});
  assert.deepEqual(deps.steps,[['register',id,{kind:'register',token,platform:'ios'}],['unregister',id,{kind:'unregister',token:'ExpoPushToken[xyz]'}]]);
  assert.deepEqual(seen,[['push-register',{kind:'user',id}],['push-register',{kind:'user',id}]]);
});

test('push-devices: stable rejections, 503 on failures, and registration keeps working in a Redis outage',async()=>{
  assert.deepEqual(plain(PUSH_DEVICE_STATUS),{invalid_request:400,account_deleted:403});
  for(const [reason,status] of [['account_deleted',403],['invalid_request',400],['account_required',503]]){
    const deps=base();deps.register=async()=>{throw new PushDeviceRejected(reason);};
    const response=await createPushDevicesHandler(deps)(post({kind:'register',token,platform:'ios'}));assert.equal(response.status,status,reason);
  }
  const down=base();down.register=async()=>{throw new Error('db');};
  const failed=await createPushDevicesHandler(down)(post({kind:'register',token,platform:'ios'}));assert.equal(failed.status,503);assert.equal(failed.headers.get('retry-after'),'5');
  const auth=base();auth.verifyUser=async()=>{throw new Error('Auth down');};assert.equal((await createPushDevicesHandler(auth)(post({kind:'register',token,platform:'ios'}))).status,503);
  for(const backend of [async()=>{throw new Error('Outage');},async()=>({success:true,reason:'timeout'}),()=>new Promise(()=>{})]){
    const deps=base();deps.limit=createRateGuard({backend,identifier:async()=>id,timeoutMs:5});
    assert.equal((await createPushDevicesHandler(deps)(post({kind:'register',token,platform:'ios'}))).status,200);assert.equal(deps.steps.length,1);
  }
  const limited=base();limited.limit=createRateGuard({backend:async()=>({success:false,limit:10,remaining:0,reset:Date.now()+30000}),identifier:async()=>id,now:Date.now});
  const reply=await createPushDevicesHandler(limited)(post({kind:'register',token,platform:'ios'}));assert.equal(reply.status,429);assert.ok(Number(reply.headers.get('retry-after'))>0);
  assert.deepEqual(limited.steps,[]);
});

test('push-devices deps pass only the verified actor and map database hints',async()=>{
  const calls=[];const rpc=(reply)=>async(name,args)=>{calls.push([name,plain(args)]);return reply;};
  const server=reply=>()=>({rpc:rpc(reply)});
  const verifier=()=>({auth:{getUser:async t=>t==='ok'?{data:{user:{id}},error:null}:t==='bad'?{data:{user:null},error:{status:401}}:{data:null,error:{status:500}}}});
  const deps=createSupabasePushDeviceDeps(verifier,server({data:{status:'registered'},error:null}));
  assert.equal(await deps.verifyUser('ok'),id);assert.equal(await deps.verifyUser('bad'),null);await assert.rejects(deps.verifyUser('down'));
  await deps.register(id,{kind:'register',token,platform:'ios'});
  assert.deepEqual(calls.at(-1),['push_device_register',{actor_user_id:id,device_input:{token,platform:'ios'}}]);
  const deleted=createSupabasePushDeviceDeps(verifier,server({data:null,error:{hint:'account_deleted'}}));
  await assert.rejects(deleted.register(id,{kind:'register',token,platform:'ios'}),e=>e instanceof PushDeviceRejected&&e.reason==='account_deleted');
  await assert.rejects(createSupabasePushDeviceDeps(verifier,server({data:{status:'removed'},error:null})).register(id,{kind:'register',token,platform:'ios'}),/unavailable/);
  await createSupabasePushDeviceDeps(verifier,server({data:{status:'removed'},error:null})).unregister(id,{kind:'unregister',token});
  assert.deepEqual(calls.at(-1),['push_device_unregister',{actor_user_id:id,device_input:{token}}]);
});

// Expo client: a fetch double records requests and replays scripted responses.
const fakeFetch=(replies,calls=[])=>Object.assign(async(url,init)=>{calls.push({url,init:{...init,body:JSON.parse(init.body)}});const next=replies.shift();
  if(next instanceof Error)throw next;return typeof next==='function'?next():new Response(JSON.stringify(next.body),{status:next.status??200,headers:next.headers??{}});},{calls});
const message=(n=1)=>Array.from({length:n},(_,i)=>({to:`ExponentPushToken[t${i}]`,title:'T',body:'B',sound:'default',data:{}}));
test('Expo send: tickets in order; DeviceNotRegistered invalid; permanent errors fail; 429/5xx/transport/shape problems retry',async()=>{
  const {createExpoPush,classifyTicket,classifyReceipt,EXPO_SEND_URL,EXPO_RECEIPTS_URL}=expoModule;
  const calls=[];const expo=createExpoPush(fakeFetch([{body:{data:[{status:'ok',id:'XXXX-1'},{status:'error',details:{error:'DeviceNotRegistered'}},
    {status:'error',details:{error:'MessageTooBig'}},{status:'error',details:{error:'MessageRateExceeded'}},{status:'ok',id:'bad id'},{status:'error'}]}}],calls),'expo-token');
  assert.deepEqual(plain(await expo.send(message(6))),{outcomes:[{outcome:'ok',ticket_id:'XXXX-1'},{outcome:'invalid'},{outcome:'error',error:'message_too_big'},
    {outcome:'retry'},{outcome:'ok',ticket_id:null},{outcome:'retry'}]});
  assert.equal(calls[0].url,EXPO_SEND_URL);assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.headers.Authorization,'Bearer expo-token');
  assert.equal(calls[0].init.body.length,6);
  const retries=n=>Array.from({length:n},()=>({outcome:'retry'}));
  for(const [reply,expected] of [[new Error('offline'),{outcomes:retries(2)}],[{status:429,body:{},headers:{'retry-after':'120'}},{outcomes:retries(2),retryAfterSeconds:120}],
    [{status:503,body:{}},{outcomes:retries(2)}],[{body:{data:[{status:'ok',id:'A'}]}},{outcomes:retries(2)}],[()=>new Response('not json'),{outcomes:retries(2)}],
    [{status:400,body:{errors:[{code:'PUSH_TOO_MANY_EXPERIENCE_IDS'}]}},{outcomes:[{outcome:'error',error:'expo_rejected'},{outcome:'error',error:'expo_rejected'}]}]]){
    const plainExpo=createExpoPush(fakeFetch([reply]));assert.deepEqual(plain(await plainExpo.send(message(2))),expected,JSON.stringify(expected));
  }
  assert.equal(createExpoPush(fakeFetch([]),undefined)&&true,true);
  await assert.rejects(createExpoPush(fakeFetch([])).send(message(101)),/batch size/);
  assert.deepEqual(plain(classifyTicket(null)),{outcome:'retry'});assert.deepEqual(plain(classifyTicket({status:'error',details:{error:'InvalidCredentials'}})),{outcome:'error',error:'invalid_credentials'});
  // Receipts: per-id classification; a failed request leaves every ticket due.
  const receiptCalls=[];const receipts=createExpoPush(fakeFetch([{body:{data:{A:{status:'ok'},B:{status:'error',details:{error:'DeviceNotRegistered'}},
    C:{status:'error',details:{error:'MessageRateExceeded'}},D:{status:'error',details:{error:'Mystery'}}}}}],receiptCalls));
  assert.deepEqual([...(await receipts.receipts(['A','B','C','D','E']))].map(plain),[['A',{outcome:'ok'}],['B',{outcome:'invalid'}],
    ['C',{outcome:'error',error:'message_rate_exceeded'}],['D',{outcome:'error',error:'expo_error'}]]);
  assert.equal(receiptCalls[0].url,EXPO_RECEIPTS_URL);assert.deepEqual(receiptCalls[0].init.body,{ids:['A','B','C','D','E']});
  assert.equal(receiptCalls[0].init.headers.Authorization,undefined);
  for(const reply of [new Error('offline'),{status:500,body:{}},{body:{data:[]}},()=>new Response('nope')])assert.equal(await createExpoPush(fakeFetch([reply])).receipts(['A']),null);
  assert.equal(classifyReceipt({status:'pending'}),undefined);
});

test('claim parsing is strict',()=>{
  const item={id:id,claim_id:'c4310000-0000-4000-8000-000000000002',kind:'booking.accepted',payload:{},devices:[{id:'c4310000-0000-4000-8000-000000000003',token}]};
  assert.deepEqual(plain(readPushClaim({items:[item],more:false})),{more:false,items:[item]});
  for(const bad of [null,[],{items:[]},{items:{},more:false},{items:[{...item,kind:'booking.nope'}],more:false},{items:[{...item,devices:[]}],more:false},
    {items:[{...item,devices:[{id:'x',token}]}],more:false},{items:[{...item,devices:[{id:item.devices[0].id,token:'abc'}]}],more:false},{items:[{...item,claim_id:'x'}],more:false}])
    assert.throws(()=>readPushClaim(bad),/Unexpected claim/,JSON.stringify(bad));
});

// Dispatcher with in-memory dependencies.
const payload=(extra={})=>({audience:'player',booking_kind:'rental',booking_id:'c4320000-0000-4000-8000-000000000001',venue_id:'c4330000-0000-4000-8000-000000000001',
  venue_name:'Court Club',starts_at:'2026-10-12T10:00:00Z',...extra});
const claimItem=(n,devices=1,extra={})=>({id:`c4340000-0000-4000-8000-${String(n).padStart(12,'0')}`,claim_id:`c4350000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  kind:'booking.accepted',payload:payload(),devices:Array.from({length:devices},(_,i)=>({id:`c4360000-0000-4000-8${String(n).padStart(3,'0')}-${String(i).padStart(12,'0')}`,token:`ExponentPushToken[d${n}x${i}]`})),...extra});
const worker=(claims,send,extra={})=>{
  const log={claims:0,completions:[],sent:[],receiptsRecorded:[]};
  return {log,deps:{secret:'s'.repeat(32),claim:async(batch,lease)=>{log.claims++;log.batch=[batch,lease];return claims.shift()??{items:[],more:false};},
    complete:async results=>{log.completions.push(plain(results));return {completed:results.length,stale:0};},
    receiptsDue:async()=>[],recordReceipts:async r=>{log.receiptsRecorded.push(plain(r));return r.length;},
    send:async messages=>{log.sent.push(plain(messages));return send(messages);},receipts:async()=>null,...extra}};
};
test('dispatch builds one message per device, records each outcome against its row and honours Retry-After',async()=>{
  const items=[claimItem(1,2),claimItem(2,1,{kind:'payment.recorded',payload:payload({amount_centavos:60000})}),claimItem(3,1,{payload:{...payload(),venue_name:''}})];
  const {log,deps}=worker([{items,more:false}],messages=>({outcomes:messages.map((m,i)=>i===0?{outcome:'ok',ticket_id:'T-1'}:i===1?{outcome:'invalid'}:{outcome:'retry'}),retryAfterSeconds:90}));
  const summary=plain(await dispatchOnce(deps));
  assert.deepEqual(summary,{claimed:3,sent:1,retried:1,invalid:1,failed:1,stale:0,receipts:0});
  assert.deepEqual(log.batch,[PUSH_BATCH,LEASE_SECONDS]);assert.equal(log.claims,1,'more:false stops after one claim');
  assert.equal(log.sent.length,1);assert.equal(log.sent[0].length,3,'invalid payload is never sent');
  const {body,...first}=log.sent[0][0];
  assert.deepEqual(first,{to:'ExponentPushToken[d1x0]',title:'Booking confirmed',
    sound:'default',data:{notification_id:items[0].id,kind:'booking.accepted',audience:'player',booking_kind:'rental',booking_id:payload().booking_id}});
  assert.match(body,/^Court Club confirmed your court rental for Oct 12, 2026, 6:00\sPM\.$/u,'Manila time (UTC+8)');
  assert.match(log.sent[0][2].body,/recorded your ₱600\.00 payment/);
  assert.deepEqual(log.completions,[[
    {id:items[0].id,claim_id:items[0].claim_id,deliveries:[{device_id:items[0].devices[0].id,outcome:'ok',ticket_id:'T-1'},{device_id:items[0].devices[1].id,outcome:'invalid'}]},
    {id:items[1].id,claim_id:items[1].claim_id,deliveries:[{device_id:items[1].devices[0].id,outcome:'retry'}],retry_after_seconds:90},
    {id:items[2].id,claim_id:items[2].claim_id,deliveries:[{device_id:items[2].devices[0].id,outcome:'error',error:'invalid_payload'}]}]]);
});

test('dispatch chunks Expo calls at 100, drains several claims, stops calling Expo when out of time and retries a failed completion once',async()=>{
  const big=Array.from({length:25},(_,n)=>claimItem(n+1,10));
  const {log,deps}=worker([{items:big,more:true},{items:[claimItem(90)],more:false}],messages=>({outcomes:messages.map(()=>({outcome:'ok',ticket_id:null}))}));
  const summary=plain(await dispatchOnce(deps));
  assert.equal(summary.claimed,26);assert.equal(summary.sent,251);assert.deepEqual(log.sent.map(m=>m.length),[100,100,50,1]);assert.equal(log.claims,2);
  let clock=0;const slow=worker([{items:[claimItem(1,10),...Array.from({length:14},(_,n)=>claimItem(n+2,10))],more:true}],messages=>{clock+=RUN_BUDGET_MS;return {outcomes:messages.map(()=>({outcome:'ok',ticket_id:null}))};},{now:()=>clock});
  const late=plain(await dispatchOnce(slow.deps));
  assert.deepEqual(slow.log.sent.map(m=>m.length),[100],'one Expo call, then out of budget');assert.equal(late.sent,100);assert.equal(late.retried,50);
  assert.equal(slow.log.claims,1,'no new claim after the budget');
  let attempts=0;const flaky=worker([{items:[claimItem(1)],more:false}],m=>({outcomes:m.map(()=>({outcome:'ok',ticket_id:'T'}))}),
    {complete:async r=>{attempts++;if(attempts===1)throw new Error('lost');return {completed:r.length,stale:0};}});
  await dispatchOnce(flaky.deps);assert.equal(attempts,2);
  const broken=worker([{items:[claimItem(1)],more:false}],m=>({outcomes:m.map(()=>({outcome:'ok',ticket_id:'T'}))}),{complete:async()=>{throw new Error('down');}});
  await assert.rejects(dispatchOnce(broken.deps));
});

test('dispatch records receipts it could read and leaves the rest due',async()=>{
  const {log,deps}=worker([],()=>({outcomes:[]}),{receiptsDue:async n=>{assert.equal(n,300);return ['A','B','C'];},
    receipts:async ids=>{assert.deepEqual(ids,['A','B','C']);return new Map([['A',{outcome:'ok'}],['C',{outcome:'invalid'}]]);}});
  assert.equal((await dispatchOnce(deps)).receipts,2);assert.deepEqual(log.receiptsRecorded,[[{ticket_id:'A',outcome:'ok'},{ticket_id:'C',outcome:'invalid'}]]);
  const down=worker([],()=>({outcomes:[]}),{receiptsDue:async()=>['A'],receipts:async()=>null});
  assert.equal((await dispatchOnce(down.deps)).receipts,0);assert.deepEqual(down.log.receiptsRecorded,[]);
});

test('push-dispatch accepts only the worker secret, by POST, and reports a run',async()=>{
  const secret='w'.repeat(40);const call=(deps,headers={},method='POST')=>createPushDispatchHandler(deps)(new Request('https://dispatch.local',{method,headers,body:method==='POST'?'{}':undefined}));
  const {log,deps}=worker([],()=>({outcomes:[]}));deps.secret=secret;
  assert.equal((await call(deps,{authorization:`Bearer ${secret}`},'GET')).status,405);
  assert.equal((await call(deps)).status,401);assert.equal((await call(deps,{authorization:`Bearer ${secret}x`})).status,401);
  assert.equal((await call(deps,{authorization:'Bearer user.jwt.token'})).status,401);assert.equal(log.claims,0,'nothing runs without the secret');
  for(const missing of [undefined,'','short'])assert.equal((await call({...deps,secret:missing},{authorization:`Bearer ${secret}`})).status,503);
  const ok=await call(deps,{authorization:`Bearer ${secret}`});assert.equal(ok.status,200);
  assert.deepEqual(await ok.json(),{claimed:0,sent:0,retried:0,invalid:0,failed:0,stale:0,receipts:0});assert.equal(ok.headers.get('cache-control'),'private, no-store');
  const down=await call({...deps,claim:async()=>{throw new Error('db');}},{authorization:`Bearer ${secret}`});assert.equal(down.status,503);assert.equal(down.headers.get('retry-after'),'30');
});
