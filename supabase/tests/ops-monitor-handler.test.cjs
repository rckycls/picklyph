const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {test}=require('node:test');const load=require('./load-ts.cjs');
const domain=require('../../packages/domain/src/ops.ts');
const handlerModule=load(path.join(__dirname,'../functions/ops-monitor/handler.ts'),{},{TextDecoder,Intl});
const {createOpsMonitorHandler,redisChecks,markerKey,REDIS_MARKER_SECONDS}=handlerModule;
const {createSupabaseOpsDeps,createDiscordPoster,createHeartbeat}=load(path.join(__dirname,'../functions/ops-monitor/deps.ts'),{},{TextDecoder,Intl});
const {createSignalReporter,observeHandler,observeGuard,supabaseSignalWriter,SIGNAL_INTERVAL_MS}=load(path.join(__dirname,'../functions/_shared/ops.ts'));
const {readUpstashConfig}=load(path.join(__dirname,'../functions/_shared/upstash.ts'),{'@upstash/redis':{Redis:class{}},'@upstash/ratelimit':{Ratelimit:class{}}});
const plain=value=>JSON.parse(JSON.stringify(value));
const secret='s'.repeat(40);const webhook='https://discord.com/api/webhooks/123456789012345678/'+'aB3_-'.repeat(12);
const alert={check:'holds.overdue',status:'fail',previous:'ok',count:2,since:'2026-10-11T10:30:00.000Z'};
const okRedis=()=>({ping:async()=>'PONG',mark:async()=>'OK',exists:async()=>0});
const base=(steps=[],patch={})=>({steps,secret,environment:'staging',webhook,redis:okRedis(),
  run:async(external)=>{steps.push(['run',plain(external)]);return {at:'2026-10-11T10:37:30.000Z',checks:[{check:'holds.overdue',status:'fail',count:2}],alerts:[alert]};},
  confirm:async(alerts)=>{steps.push(['confirm',plain(alerts)]);return alerts.length;},
  post:async(url,content)=>{steps.push(['post',url,content]);return true;},ping:async(url)=>{steps.push(['ping',url]);},...patch});
const call=(handler,init={})=>handler(new Request('https://ops.local',{method:'POST',headers:{authorization:`Bearer ${secret}`},body:'{}',...init}));

test('ops-monitor accepts only its worker secret and a valid configuration, and does nothing otherwise',async()=>{
  const steps=[];const handler=createOpsMonitorHandler(base(steps));
  assert.equal((await call(handler,{method:'GET',body:undefined})).status,405);
  assert.equal((await call(handler,{headers:{}})).status,401);
  assert.equal((await call(handler,{headers:{authorization:'Bearer '+'t'.repeat(40)}})).status,401);
  assert.equal((await call(handler,{headers:{authorization:'Bearer eyJhbGciOiJIUzI1NiJ9.user.token'}})).status,401,'a user token is not the worker secret');
  for(const patch of [{secret:undefined},{secret:'short'}])assert.deepEqual(plain(await (await call(createOpsMonitorHandler(base(steps,patch)))).json()),{error:'not_configured'});
  for(const patch of [{webhook:undefined},{webhook:'http://discord.com/api/webhooks/1/x'},{webhook:'http://127.0.0.1:4000/api/webhooks/1/fake'},{heartbeat:'http://hc.example/x'}]){
    const reply=await call(createOpsMonitorHandler(base(steps,patch)));assert.equal(reply.status,503,JSON.stringify(patch));
    assert.deepEqual(plain(await reply.json()),{error:'not_configured'});
  }
  assert.equal((await call(createOpsMonitorHandler(base(steps,{environment:'local',webhook:'http://127.0.0.1:4000/api/webhooks/1/fake'})))).status,200,'a loopback fake works locally');
  assert.deepEqual(steps.map(s=>s[0]),['run','post','confirm'],'only the configured local run did anything');
});

test('a run posts one message for its alerts, confirms only after Discord accepted it, then pings the heartbeat',async()=>{
  const steps=[];const reply=await call(createOpsMonitorHandler(base(steps,{heartbeat:'https://hc.example/ping'})));
  assert.equal(reply.status,200);assert.equal(reply.headers.get('cache-control'),'private, no-store');
  assert.deepEqual(plain(await reply.json()),{checks:[{check:'holds.overdue',status:'fail',count:2}],alerts:1});
  assert.deepEqual(steps.map(s=>s[0]),['run','post','confirm','ping']);
  assert.deepEqual(steps[0][1],[{check:'redis.reachable',status:'ok',count:0},{check:'redis.isolation',status:'ok',count:0}]);
  assert.equal(steps[1][1],webhook);assert.equal(steps[1][2],domain.opsAlertMessage('staging',[alert]));
  assert.deepEqual(steps[2][1],[alert]);assert.equal(steps[3][1],'https://hc.example/ping');
  // Nothing due: no post and no confirmation, but the heartbeat still says the monitor ran.
  const quiet=[];const none=await call(createOpsMonitorHandler(base(quiet,{heartbeat:'https://hc.example/ping',
    run:async()=>({at:'2026-10-11T10:37:30.000Z',checks:[{check:'holds.overdue',status:'ok',count:0}],alerts:[]})})));
  assert.equal(none.status,200);assert.deepEqual(quiet.map(s=>s[0]),['ping']);
  // No heartbeat configured: none sent.
  const plainRun=[];await call(createOpsMonitorHandler(base(plainRun)));assert.deepEqual(plainRun.map(s=>s[0]),['run','post','confirm']);
});

test('failures leave alerts unconfirmed for the next run and skip the heartbeat',async()=>{
  const refused=[];const reply=await call(createOpsMonitorHandler(base(refused,{heartbeat:'https://hc.example/ping',post:async()=>{refused.push(['post']);return false;}})));
  assert.equal(reply.status,502);assert.equal((await reply.json()).error,'delivery_failed');assert.deepEqual(refused.map(s=>s[0]),['run','post']);
  const down=[];const db=await call(createOpsMonitorHandler(base(down,{heartbeat:'https://hc.example/ping',run:async()=>{throw new Error('down');}})));
  assert.equal(db.status,503);assert.equal(db.headers.get('retry-after'),'60');assert.deepEqual(down,[]);
  const lost=[];const confirm=await call(createOpsMonitorHandler(base(lost,{heartbeat:'https://hc.example/ping',confirm:async()=>{throw new Error('lost');}})));
  assert.equal(confirm.status,503);assert.deepEqual(lost.map(s=>s[0]),['run','post']);
});

test('Redis checks: reachability with this environment, a marker under its own namespace, and other environments sharing the database',async()=>{
  const calls=[];const probe={ping:async()=>{calls.push('ping');return 'PONG';},mark:async(...a)=>{calls.push(['mark',...a]);return 'OK';},exists:async(keys)=>{calls.push(['exists',...keys]);return 0;}};
  assert.deepEqual(plain(await redisChecks(probe,'staging')),[{check:'redis.reachable',status:'ok',count:0},{check:'redis.isolation',status:'ok',count:0}]);
  assert.deepEqual(plain(calls),['ping',['mark','pickly:staging:ops:environment','staging',REDIS_MARKER_SECONDS],['exists','pickly:local:ops:environment','pickly:production:ops:environment']]);
  assert.equal(REDIS_MARKER_SECONDS,172800);assert.equal(markerKey('production'),'pickly:production:ops:environment');
  assert.deepEqual(plain(await redisChecks({...okRedis(),exists:async()=>1},'production')),[{check:'redis.reachable',status:'ok',count:0},{check:'redis.isolation',status:'fail',count:1}]);
  const unreachable=[{check:'redis.reachable',status:'fail',count:1}];
  assert.deepEqual(plain(await redisChecks(null,'staging')),unreachable,'no settings');
  assert.deepEqual(plain(await redisChecks(okRedis(),undefined)),unreachable,'no PICKLY_ENV');
  assert.deepEqual(plain(await redisChecks(okRedis(),'qa')),unreachable,'unknown PICKLY_ENV');
  assert.deepEqual(plain(await redisChecks({...okRedis(),ping:async()=>{throw new Error('401');}},'staging')),unreachable,'refused');
  assert.deepEqual(plain(await redisChecks({...okRedis(),mark:async()=>{throw new Error('READONLY');}},'staging')),unreachable,'read-only');
  assert.deepEqual(plain(await redisChecks({...okRedis(),exists:async()=>'1'},'staging')),unreachable,'malformed reply');
  const started=Date.now();assert.deepEqual(plain(await redisChecks({...okRedis(),ping:()=>new Promise(()=>{})},'staging',50)),unreachable,'hung');
  assert.ok(Date.now()-started<1000,'the deadline holds');
  // The monitor reads the same settings as the rate guard.
  const env=values=>name=>values[name];const good={PICKLY_ENV:'staging',UPSTASH_REDIS_REST_URL:'https://eu1-x.upstash.io',UPSTASH_REDIS_REST_TOKEN:'t',RATE_LIMIT_KEY_SECRET:'k'.repeat(32)};
  assert.deepEqual(plain(readUpstashConfig(env(good))),{environment:'staging',url:'https://eu1-x.upstash.io',token:'t',salt:'k'.repeat(32)});
  for(const patch of [{PICKLY_ENV:'qa'},{UPSTASH_REDIS_REST_URL:'http://eu1-x.upstash.io'},{UPSTASH_REDIS_REST_URL:'https://evil.test'},{UPSTASH_REDIS_REST_URL:'https://eu1-x.upstash.io/path'},
    {UPSTASH_REDIS_REST_TOKEN:''},{RATE_LIMIT_KEY_SECRET:'short'}])assert.equal(readUpstashConfig(env({...good,...patch})),null,JSON.stringify(patch));
});

test('Discord delivery: JSON content without mentions or redirects; only a 2xx counts; the heartbeat never throws',async()=>{
  const seen=[];const poster=createDiscordPoster(async(url,init)=>{seen.push([url,init]);return new Response('{}',{status:200});});
  assert.equal(await poster(webhook,'hello'),true);
  assert.equal(seen[0][0],`${webhook}?wait=true`);assert.equal(seen[0][1].method,'POST');assert.equal(seen[0][1].redirect,'error');
  assert.deepEqual(JSON.parse(seen[0][1].body),{content:'hello',username:'PicklyPH monitor',allowed_mentions:{parse:[]}});
  assert.equal(await createDiscordPoster(async()=>new Response(null,{status:204}))(webhook,'x'),true);
  for(const status of [400,401,404,429,500,503])assert.equal(await createDiscordPoster(async()=>new Response('{}',{status}))(webhook,'x'),false,String(status));
  assert.equal(await createDiscordPoster(async()=>{throw new Error('offline');})(webhook,'x'),false);
  const pinged=[];await createHeartbeat(async(url,init)=>{pinged.push([url,init.method,init.redirect]);return new Response('OK');})('https://hc.example/ping');
  assert.deepEqual(pinged,[['https://hc.example/ping','GET','error']]);
  await createHeartbeat(async()=>{throw new Error('offline');})('https://hc.example/ping');
});

test('Supabase deps parse runs strictly and confirm only check and status',async()=>{
  const calls=[];const server=()=>({rpc:async(name,args)=>{calls.push([name,plain(args)]);
    return name==='ops_monitor_run'?{data:{at:'2026-10-11T10:37:30.06229+00:00',checks:[],alerts:[{...alert,since:'2026-10-11T10:30:00+00:00'}]},error:null}:{data:{confirmed:1},error:null};}});
  const deps=createSupabaseOpsDeps(server);
  const run=await deps.run([{check:'redis.reachable',status:'ok',count:0}]);
  assert.equal(run.alerts[0].since,'2026-10-11T10:30:00.000Z');assert.equal(await deps.confirm([alert]),1);
  assert.deepEqual(calls,[['ops_monitor_run',{external_checks:[{check:'redis.reachable',status:'ok',count:0}]}],['ops_alerts_confirm',{alerts:[{check:'holds.overdue',status:'fail'}]}]]);
  await assert.rejects(createSupabaseOpsDeps(()=>({rpc:async()=>({data:null,error:{message:'down'}})})).run([]),/Monitor unavailable/);
  await assert.rejects(createSupabaseOpsDeps(()=>({rpc:async()=>({data:{at:'x',checks:[],alerts:[]},error:null})})).run([]),/Unexpected monitor run/);
  await assert.rejects(createSupabaseOpsDeps(()=>({rpc:async()=>({data:{confirmed:'1'},error:null})})).confirm([alert]),/Monitor unavailable/);
});

test('signals: at most one write per kind per minute, counts carried to the next write, and never in the response path',async()=>{
  let now=1_000_000;const writes=[];const deferred=[];
  const note=createSignalReporter('rental-bookings',async(...a)=>{writes.push(a);},{now:()=>now,defer:t=>deferred.push(t)});
  note('unavailable');assert.deepEqual(writes,[['rental-bookings','unavailable',1]],'the first one is written at once');
  note('unavailable');note('unavailable');now+=SIGNAL_INTERVAL_MS-1;note('unavailable');assert.equal(writes.length,1,'then held for a minute');
  note('server_error');assert.deepEqual(writes[1],['rental-bookings','server_error',1],'each kind has its own minute');
  now+=1;note('unavailable');assert.deepEqual(writes[2],['rental-bookings','unavailable',4],'the held three plus this one');
  assert.equal(deferred.length,3,'every write is handed to the background');
  // A failing or throwing writer never escapes.
  const failing=createSignalReporter('venue-search',async()=>{throw new Error('down');},{now:()=>now,defer:t=>deferred.push(t)});failing('server_error');
  await Promise.all(deferred);
  const throwing=createSignalReporter('venue-search',()=>{throw new Error('no client');},{now:()=>now,defer:()=>assert.fail('nothing to defer')});
  throwing('server_error');
  let burst=0;const capped=createSignalReporter('venue-search',async(s,k,n)=>{burst=n;},{now:()=>now,defer:()=>{}});
  capped('unavailable');for(let n=0;n<20000;n++)capped('unavailable');now+=SIGNAL_INTERVAL_MS;capped('unavailable');assert.equal(burst,10000,'capped at the command bound');
});

test('observers note 503s, other 5xx, throws and limiter outages, and pass every answer through unchanged',async()=>{
  const notes=[];const note=kind=>notes.push(kind);
  for(const status of [200,400,401,404,409,429,500,502,503,504]){
    const response=new Response(null,{status});assert.equal(await observeHandler(async()=>response,note)(new Request('https://x.local')),response);
  }
  assert.deepEqual(notes,['server_error','server_error','unavailable','server_error']);
  await assert.rejects(observeHandler(async()=>{throw new Error('boom');},note)(new Request('https://x.local')),/boom/);assert.equal(notes.at(-1),'server_error');
  for(const [state,expected] of [['enforced',[]],['degraded',['limiter_degraded']],['bypassed',[]]]){
    notes.length=0;const decision={allowed:state!=='degraded',status:200,state,headers:{}};
    assert.equal(await observeGuard(async()=>decision,note)('hold-create',{kind:'user',id:'u'}),decision);
    assert.deepEqual(notes,expected,state);
  }
  const rpc=[];await supabaseSignalWriter(()=>({rpc:async(...a)=>{rpc.push(plain(a));return {error:null};}}))('push-devices','limiter_degraded',3);
  assert.deepEqual(rpc,[['ops_signal_record',{signal_source:'push-devices',signal_kind:'limiter_degraded',occurrences:3}]]);
  await assert.rejects(supabaseSignalWriter(()=>({rpc:async()=>({error:{message:'denied'}})}))('push-devices','server_error',1),/Signal not recorded/);
});

test('every served function reports signals under its own name; guarded ones also observe the rate guard',()=>{
  const functions=path.join(__dirname,'../functions');
  for(const name of domain.OPS_SIGNAL_SOURCES){
    const source=fs.readFileSync(path.join(functions,name,'index.ts'),'utf8');
    assert.match(source,new RegExp(`createSignalReporter\\('${name}', supabaseSignalWriter\\(server\\)\\)`),name);
    assert.match(source,/Deno\.serve\(observeHandler\(/,name);assert.match(source,/, note\)\);\s*$/,name);
    if(source.includes('buildUpstashGuard')){
      assert.match(source,/const guard = observeGuard\(buildUpstashGuard\(env\), note\);/,name);
      assert.equal(source.match(/buildUpstashGuard\(/g).length,1,`${name}: one guard`);
    }
  }
  const monitor=fs.readFileSync(path.join(functions,'ops-monitor/index.ts'),'utf8');
  assert.doesNotMatch(monitor,/createSignalReporter/,'the monitor does not report on itself');
});
