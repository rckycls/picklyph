// T51d: real local Docker/Auth/PostgREST and the served crash-reports function with Redis absent. The shipped mobile queue sends
// a report the way the app does (public key only, no account token); it must be stored once, scrubbed, raise app.crashes on a
// monitor run (a development build's must not), and reach the admin-only console read. No hosted or mobile env.
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {randomUUID}=require('node:crypto');const {execFileSync,spawn}=require('node:child_process');const {createClient}=require('@supabase/supabase-js');
const load=require('./load-ts.cjs');
const root=path.resolve(__dirname,'../..');
const domain=require(path.join(root,'packages/domain/src/crash.ts'));
const mobile=load(path.join(root,'src/features/crash/crashClient.ts'),{'@picklyph/domain':domain});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const dockerPath=path.join(process.env.LOCALAPPDATA??'','Programs/DockerDesktop/resources/bin/docker.exe');const docker=fs.existsSync(dockerPath)?dockerPath:'docker';
  const run=(args,input)=>execFileSync(docker,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});
  const context=run(['context','show']).trim();const host=process.env.DOCKER_HOST||run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://')||host.startsWith('unix://'),'Local Docker required');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(),'picklyph');
  const args=['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'];
  const sql=query=>run(args,query).trim();
  assert.equal(sql("select to_regclass('private.app_crashes') is not null"),'t','Apply the T51d migration locally first (npx supabase migration up --local)');
  const inventory=()=>sql(`select jsonb_build_object('users',(select jsonb_agg(id order by id) from auth.users),'roles',(select jsonb_agg(to_jsonb(r) order by user_id,role) from private.account_roles r),
    'crashes',(select jsonb_agg(id order by id) from private.app_crashes),
    'state',(select jsonb_agg(to_jsonb(s) order by check_name) from private.ops_alert_state s),'signals',(select jsonb_agg(to_jsonb(s) order by minute,source,kind) from private.ops_signals s));`);
  const beforeInventory=inventory();const before=JSON.parse(beforeInventory);
  const literal=value=>`'${JSON.stringify(value??[]).replace(/'/g,"''")}'::jsonb`;

  run([...args,'-o','/dev/null'],fs.readFileSync(path.join(__dirname,'crash-reports.sql'),'utf8'));
  console.log('PASS: Docker crash-reports SQL: grants, the strict contract, one row per report, the daily cap, app.crashes, admin-only 7-day groups, 30-day retention.');

  const cli=path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');const config=JSON.parse(execFileSync(cli,['status','-o','json'],{stdio:['ignore','pipe','pipe'],timeout:20000}));
  const api=new URL(config.API_URL);assert.ok(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)&&api.port==='54321','Loopback required');
  const options={auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}};
  const service=createClient(api.href,config.SERVICE_ROLE_KEY,options);const anon=createClient(api.href,config.ANON_KEY,options);
  const check=(r,message)=>{assert.ok(!r.error,`${message}: ${r.error?.message??''}`);return r.data;};
  const users=[];const ids=[];let child;const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pickly-crash-'));
  try{
    // Accounts: 0 admin, 1 moderator, 2 player.
    for(let n=0;n<3;n++)users.push(check(await service.auth.admin.createUser({email:`crash-${randomUUID()}@example.test`,password:`Local-${randomUUID()}!`,email_confirm:true}),'Own account').user.id);
    sql(`insert into private.account_roles(user_id,role) values('${users[0]}','admin'),('${users[1]}','moderator');`);

    // Serve the pinned Edge runtime with Redis deliberately absent: crash reports follow the "continue" outage policy.
    const envPath=path.join(temp,'functions.env');
    fs.writeFileSync(envPath,[`DISCOVERY_SUPABASE_URL=http://kong:8000`,`DISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}`,`DISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}`,
      'PICKLY_ENV=local',''].join('\n'));
    const edgeId=()=>{try{return run(['ps','-q','--filter','name=^supabase_edge_runtime_picklyph$']).trim();}catch{return '';}};
    const staleEdge=edgeId();
    child=spawn(cli,['functions','serve','--env-file',envPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});let launchError=false;child.on('error',()=>{launchError=true;});
    const endpoint=new URL('functions/v1/crash-reports',api).href;
    const invoke=(init={})=>fetch(endpoint,{method:'POST',...init,headers:{apikey:config.ANON_KEY,'content-type':'application/json',...init.headers},signal:AbortSignal.timeout(30000)});
    let ready=false;for(let n=0;n<120;n++){assert.ok(!launchError&&child.exitCode===null,'Own server running');
      try{const current=edgeId();if(current&&current!==staleEdge&&(await invoke({method:'GET'})).status===405){ready=true;break;}}catch{}
      await sleep(500);}
    assert.ok(ready,'Fresh Edge ready');
    assert.equal((await invoke({body:'x'.repeat(domain.MAX_CRASH_BYTES+1)})).status,413,'oversize');
    assert.equal((await invoke({body:'{"id":1}'})).status,400,'malformed');
    assert.equal((await invoke({body:'{}',headers:{'content-type':'text/plain'}})).status,415,'not JSON');
    assert.equal(sql('select count(*) from private.app_crashes'),String(before.crashes?.length??0),'nothing stored by refused calls');
    console.log('PASS: served crash-reports: GET 405, oversize 413, malformed 400, not JSON 415, nothing stored.');

    // The shipped mobile queue, sending exactly as the app does: the public key, no account token.
    const store=new Map();const statuses=[];
    const queue=mobile.createCrashQueue({store:{getItem:async k=>store.get(k)??null,setItem:async(k,v)=>{store.set(k,v);}},now:Date.now,
      send:async report=>{const r=await fetch(endpoint,{method:'POST',headers:{apikey:config.ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify(report),signal:AbortSignal.timeout(30000)});statuses.push(r.status);return r.status;}});
    const app={version:'0.1.0',variant:'preview',os:'ios',osVersion:'18.6'};
    const error=new TypeError('No booking for ana.reyes@example.com, call 0917 123 4567');
    error.stack='TypeError: No booking for ana.reyes@example.com\n    at load (address at index.bundle:1:2345)';
    const preview=mobile.buildCrashReport(error,'fatal',{route:`/rental/booking/${randomUUID()}`},app,randomUUID(),Date.now());ids.push(preview.id);
    await queue.add(preview);await queue.flush();
    assert.deepEqual(statuses,[200]);assert.deepEqual(JSON.parse(store.get(mobile.CRASH_QUEUE_KEY)),[],'sent and removed from the phone');
    const row=JSON.parse(sql(`select to_jsonb(c) from private.app_crashes c where id='${preview.id}'`));
    assert.equal(row.message,'No booking for <email>, call <number>');assert.equal(row.stack,'TypeError: No booking for <email>\n    at load (address at index.bundle:1:2345)');
    assert.equal(row.route,'/rental/booking/[id]');assert.equal(row.variant,'preview');assert.match(row.fingerprint,/^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(row).sort(),['app_version','component_stack','fingerprint','id','kind','message','name','occurred_at','os','os_version','received_at','route','stack','variant'],
      'no account, device or address columns');
    // The phone resends it (the answer was lost): stored once.
    await queue.add(preview);await queue.flush();
    assert.deepEqual(statuses,[200,200]);assert.equal(sql(`select count(*) from private.app_crashes where id='${preview.id}'`),'1','stored once');
    // Redis is absent here: the guard ran degraded and the function reported it.
    for(let n=0;n<20&&sql(`select count(*) from private.ops_signals where source='crash-reports' and kind='limiter_degraded'`)==='0';n++)await sleep(500);
    assert.ok(Number(sql(`select count(*) from private.ops_signals where source='crash-reports' and kind='limiter_degraded'`))>=1,'limiter outage signalled');
    console.log('PASS: the shipped mobile queue sent a fatal report with the public key only; stored once (resend recognised), scrubbed (<email>, <number>, route [id]), with a server fingerprint and no person columns; limiter_degraded signalled.');

    // A development build's crash is stored but never alerts; a monitor run raises app.crashes for the preview crash only.
    const dev=mobile.buildCrashReport(new Error('dev only'),'fatal',{route:'/'},{...app,variant:'development'},randomUUID(),Date.now());ids.push(dev.id);
    const render=mobile.buildCrashReport(new Error('sheet broke'),'render',{route:'/',componentStack:'in VenueSheet\n in Screen'},app,randomUUID(),Date.now());ids.push(render.id);
    await queue.add(dev);await queue.add(render);await queue.flush();
    assert.deepEqual(statuses,[200,200,200,200]);
    sql('delete from private.ops_alert_state;');
    const runResult=JSON.parse(sql(`select public.ops_monitor_run('[]')::text`));
    const crashCheck=runResult.checks.find(c=>c.check==='app.crashes');const crashAlert=runResult.alerts.find(a=>a.check==='app.crashes');
    const ownOnly=Number(sql(`select count(*) from private.app_crashes where received_at>clock_timestamp()-interval '1 hour' and kind in ('fatal','render') and variant<>'development' and id not in ('${ids.join("','")}')`));
    assert.deepEqual(crashCheck,{check:'app.crashes',status:'warn',count:2+ownOnly},'the preview crash and the failed screen count, the development crash does not');
    assert.equal(crashAlert.status,'warn');assert.equal(crashAlert.previous,'ok');
    console.log(`PASS: a monitor run raised app.crashes warn:${crashCheck.count} (the preview crash and the preview failed screen); the development build's crash was stored but not counted.`);

    // The console read: admins only, rechecked by the database; nothing about who crashed.
    const view=domain.readCrashAdminView(check(await service.rpc('crash_admin_read',{actor_user_id:users[0]}),'Admin read'));
    const group=view.groups.find(g=>g.fingerprint===row.fingerprint);
    assert.ok(group&&group.reports===1&&group.preview===1&&group.message==='No booking for <email>, call <number>','the admin sees the group');
    assert.ok(view.groups.some(g=>g.kind==='render'&&g.component_stack==='in VenueSheet\n in Screen'),'the failed screen with its components');
    assert.ok(!JSON.stringify(view).includes('example.com')&&!users.some(id=>JSON.stringify(view).includes(id)),'no emails or account IDs');
    for(const actor of [users[1],users[2]]){const r=await service.rpc('crash_admin_read',{actor_user_id:actor});assert.equal(r.error?.code,'42501','moderator and player refused');}
    for(const [name,params] of [['crash_admin_read',{actor_user_id:users[0]}],['crash_report_record',{report:{...preview,fingerprint:row.fingerprint}}]]){
      const r=await anon.rpc(name,params);assert.equal(r.error?.code,'42501',`anon ${name}`);}
    const table=await fetch(new URL('rest/v1/app_crashes',api).href,{headers:{apikey:config.ANON_KEY}});assert.equal(table.status,404,'the table is not exposed');
    console.log('PASS: crash_admin_read for an admin lists the scrubbed groups (no emails or account IDs); moderator and player 42501; anon RPCs 42501; the table is not exposed (404).');
  }finally{
    if(child&&child.exitCode===null)child.kill();let clean=true;const steps=[];
    if(ids.length)steps.push(()=>sql(`delete from private.app_crashes where id in ('${ids.join("','")}');`));
    if(users.length)steps.push(()=>sql(`delete from private.account_roles where user_id in ('${users.join("','")}');`));
    for(const id of users)steps.push(async()=>{const r=await service.auth.admin.deleteUser(id);assert.ok(!r.error||r.error.status===404,'Own account cleanup');});
    // Alert state and signals go back to exactly what was there before.
    steps.push(()=>{
      sql(`delete from private.ops_alert_state;insert into private.ops_alert_state select * from jsonb_populate_recordset(null::private.ops_alert_state,${literal(before.state)});
        delete from private.ops_signals;insert into private.ops_signals select * from jsonb_populate_recordset(null::private.ops_signals,${literal(before.signals)});`);});
    steps.push(()=>{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert.match(path.basename(temp),/^pickly-crash-/);fs.rmSync(temp,{recursive:true,force:true});});
    for(const c of [service,anon])steps.push(()=>c.auth.stopAutoRefresh());
    for(const step of steps)try{await step();}catch{clean=false;}assert.ok(clean,'Own fixtures/env removed');assert.equal(inventory(),beforeInventory,'Pre-existing rows preserved');
  }
  console.log('PASS: own crash reports, accounts, roles, signals, alert state and temp removed; pre-existing rows preserved; no hosted changes.');
}
main().catch(error=>{console.error(`Local crash report check failed: ${error instanceof assert.AssertionError?error.message:'Check local migrations, API and Edge setup.'}`);if(process.env.PICKLY_DEBUG)console.error(error);process.exitCode=1;});
