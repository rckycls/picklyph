// Local Docker/PostgREST + actual Edge Runtime. Never loads hosted/mobile env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
// T14 mobile modules use type-only imports, so Node loads the shipped client code directly.
const { searchVenues } = require('../../src/features/discovery/searchClient.ts');
const { loadVenueDetail } = require('../../src/features/discovery/venueDetail.ts');

async function main() {
  const dockerPath = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
  const docker = fs.existsSync(dockerPath) ? dockerPath : 'docker';
  const run = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', stdio: ['pipe','pipe','pipe'], timeout: 30000 });
  const context = run(['context','show']).trim();
  const host = process.env.DOCKER_HOST || run(['context','inspect',context,'--format','{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://') || host.startsWith('unix://'), 'Requires a local Docker engine.');
  assert.equal(run(['inspect','supabase_db_picklyph','--format','{{index .Config.Labels "com.supabase.cli.project"}}']).trim(), 'picklyph');
  run(['exec','-i','supabase_db_picklyph','psql','-U','postgres','-d','postgres','-X','-q','-v','ON_ERROR_STOP=1','-o','/dev/null'], fs.readFileSync(path.join(__dirname,'search.sql'),'utf8'));
  console.log('PASS: Docker PostgreSQL spatial/filter/pagination/input/ACL suite; fixtures rolled back.');
  const cli = path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config = JSON.parse(execFileSync(cli, ['status','-o','json'], { stdio: ['ignore','pipe','pipe'], timeout: 20000 }));
  const api = new URL(config.API_URL);
  assert.ok(api.protocol === 'http:' && ['localhost','127.0.0.1'].includes(api.hostname) && api.port === '54321', 'Requires loopback Supabase.');
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input,init) => fetch(input,{...init,signal:AbortSignal.timeout(10000)}) } };
  const service = createClient(api.href, config.SERVICE_ROLE_KEY, options);
  const anonymous = createClient(api.href, config.ANON_KEY, options);
  const player = createClient(api.href, config.ANON_KEY, options);
  const check = (result,message) => { assert.ok(!result.error,message); return result.data; };
  const venueId = randomUUID(); const venueTwo = randomUUID(); const city = `Search-${randomUUID()}`;
  let created = false; let createdTwo = false; let userId; let child;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'pickly-search-'));
  try {
    check(await service.from('venues').insert({ id:venueId, name:'Local Edge search fixture', address_line:'Fixture address',city,province:'Fixture',latitude:14.6,longitude:121,publication_status:'approved' }), 'Fixture venue creation');
    created = true;
    check(await service.from('courts').insert({ venue_id:venueId,name:'Court',surface:'hard',is_indoor:true,is_covered:true }), 'Fixture court creation');
    check(await service.from('courts').insert({ venue_id:venueId,name:'Closed court',surface:'other',status:'inactive' }), 'Inactive fixture court');
    check(await service.from('venues').insert({ id:venueTwo, name:'Local unclaimed fixture', address_line:'Second address',city,province:'Fixture',latitude:14.6005,longitude:121.0005,publication_status:'approved' }), 'Second fixture venue');
    createdTwo = true;
    check(await service.from('courts').insert({ venue_id:venueTwo,name:'Outdoor court',surface:'synthetic',is_indoor:false,is_covered:false }), 'Second fixture court');
    const credentials = { email:`search-${randomUUID()}@example.test`, password:`Local-${randomUUID()}!` };
    userId = check(await service.auth.admin.createUser({...credentials,email_confirm:true}), 'Fixture user creation').user.id;
    const session = check(await player.auth.signInWithPassword(credentials), 'Fixture user login').session;
    assert.ok((await anonymous.rpc('directory_search',{search:{city}})).error, 'Anon must not bypass guarded RPC');
    assert.ok((await player.rpc('directory_search',{search:{city}})).error, 'Player must not bypass guarded RPC');
    // Internal Docker URL is visible only to our local function. Keys remain in
    // this ephemeral env file; no Redis secrets configured, to prove fallback.
    const envPath = path.join(temp,'function.env');
    fs.writeFileSync(envPath,[
      'DISCOVERY_SUPABASE_URL=http://kong:8000',
      `DISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}`,
      `DISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}`,
      'DISCOVERY_IP_SOURCE=unknown','PICKLY_ENV=local',
    ].join('\n'), {mode:0o600});
    child = spawn(cli,['functions','serve','venue-search','--env-file',envPath],{ windowsHide:true,stdio:['ignore','pipe','pipe'] });
    // Consume logs without printing possible infrastructure/request values.
    child.stdout.on('data',()=>{}); child.stderr.on('data',()=>{});
    let launchError = false; child.on('error',()=>{ launchError = true; });
    const endpoint = new URL('functions/v1/venue-search',api);
    const invoke = (query,token,extra={}) => fetch(`${endpoint}?${query}`,{ headers:{apikey:config.ANON_KEY,...(token?{authorization:`Bearer ${token}`} : {}),...extra},signal:AbortSignal.timeout(5000) });
    let ready = false;
    for (let attempt=0;attempt<90;attempt++) {
      assert.ok(!launchError && child.exitCode === null, 'Own local Edge server must remain running.');
      try { if ((await invoke(`city=${encodeURIComponent(city)}`)).status === 200) {ready=true;break;} } catch {}
      await new Promise((resolve)=>setTimeout(resolve,500));
    }
    assert.ok(ready,'Local Edge endpoint must become ready.');
    const query = `city=${encodeURIComponent(city)}&indoor=true&covered=true&surface=hard&limit=1`;
    for (const token of [null,session.access_token]) {
      const response = await invoke(query,token); assert.equal(response.status,200,'Guest and verified-player search');
      const body = await response.json(); assert.equal(body.venues.length,1); assert.equal(body.venues[0].id,venueId);
      assert.equal(body.venues[0].active_court_count,1); assert.equal(body.next_cursor,null);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      assert.ok(!JSON.stringify(body).includes(config.SERVICE_ROLE_KEY));
    }
    assert.equal((await invoke('city=Manila&limit=51')).status,400);
    assert.equal((await invoke(query,'forged-token')).status,401);
    const forged = `${session.access_token.split('.')[0]}.${Buffer.from(JSON.stringify({sub:userId,role:'authenticated',exp:9999999999})).toString('base64url')}.forged`;
    assert.equal((await invoke(query,forged)).status,401,'Forged user ID must fail actual getUser');
    assert.equal((await invoke(query,null,{'x-forwarded-for':'forged','cf-connecting-ip':'203.0.113.4'})).status,200,'Unknown ingress ignores spoofed headers and remains bounded');
    // T14: the shipped mobile client against the actual endpoint, plus public-RLS detail reads.
    const mobile = { endpoint:endpoint.href, apiKey:config.ANON_KEY, accessToken:async()=>null, fetch:(url,init)=>fetch(url,{...init,signal:init.signal??AbortSignal.timeout(5000)}) };
    const area = { bounds:{south:14.59,west:120.99,north:14.61,east:121.01}, city, indoor:null, covered:null, surface:null };
    const first = await searchVenues(mobile,area,{limit:1}); assert.ok(first.ok && first.page.venues.length===1 && first.page.next_cursor,'Mobile first page');
    const second = await searchVenues(mobile,area,{after:first.page.next_cursor,limit:1}); assert.ok(second.ok && second.page.venues.length===1 && second.page.next_cursor===null,'Mobile cursor page');
    assert.deepEqual(new Set([first.page.venues[0].id,second.page.venues[0].id]),new Set([venueId,venueTwo]),'Pages are disjoint and complete');
    const outdoor = await searchVenues(mobile,{...area,indoor:false,surface:'synthetic'}); assert.ok(outdoor.ok);
    assert.deepEqual(outdoor.page.venues.map((v)=>[v.id,v.claim_status,v.active_court_count]),[[venueTwo,'unclaimed',1]],'Mobile same-court filters');
    for (const token of [session.access_token,forged]) {
      const signed = await searchVenues({...mobile,accessToken:async()=>token},area); assert.ok(signed.ok && signed.page.venues.length===2,'Verified bearer or guest fallback after 401');
    }
    const detail = await loadVenueDetail(anonymous,venueId);
    assert.deepEqual(detail.courts.map((c)=>[c.name,c.surface,c.is_indoor]),[['Court','hard',true]],'Detail lists active courts only');
    assert.equal((await loadVenueDetail(anonymous,venueTwo)).claim_status,'unclaimed');
    assert.ok(!JSON.stringify(detail).includes('evidence') && !('publication_status' in detail),'Detail projects public fields only');
    check(await service.from('venues').update({publication_status:'suspended'}).eq('id',venueId),'Suspend fixture');
    const suspended = await invoke(query); assert.equal(suspended.status,200); assert.equal((await suspended.json()).venues.length,0,'Publication changes apply next query');
    const after = await searchVenues(mobile,area); assert.ok(after.ok); assert.deepEqual(after.page.venues.map((v)=>v.id),[venueTwo],'Mobile search drops suspended venue');
    assert.equal(await loadVenueDetail(anonymous,venueId),null,'Suspended detail reads as no longer listed');
    console.log('PASS: T14 mobile client pages/filters/bearer fallback and current public detail (active courts, suspension) against actual local endpoint.');
    console.log('PASS: actual local Edge Runtime guest/verified-player search, client RPC denial, filters, forged JWT, suspension, sanitized output and missing-Redis bounded fallback.');
  } finally {
    if (child && child.exitCode === null) {
      const stopped = new Promise((resolve)=>child.once('exit',resolve)); child.kill();
      await Promise.race([stopped,new Promise((resolve)=>setTimeout(resolve,2000))]);
    }
    let clean = true;
    for (const step of [
      ...(created?[()=>service.from('venues').delete().eq('id',venueId).then((r)=>check(r,'Own venue cleanup'))]:[]),
      ...(createdTwo?[()=>service.from('venues').delete().eq('id',venueTwo).then((r)=>check(r,'Own second venue cleanup'))]:[]),
      ...(userId?[()=>service.auth.admin.deleteUser(userId).then((r)=>check(r,'Own user cleanup'))]:[]),
      ()=>service.auth.stopAutoRefresh(),()=>anonymous.auth.stopAutoRefresh(),()=>player.auth.stopAutoRefresh(),
      ()=>{
        assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()),'Cleanup target must remain in the intended temp directory.');
        assert.match(path.basename(temp),/^pickly-search-/,'Cleanup target must be this test’s directory.');
        fs.rmSync(temp,{recursive:true,force:true});
      },
    ]) { try {await step();} catch {clean=false;} }
    assert.ok(clean,'Own local fixtures and temporary credential file must be removed.');
  }
  console.log('PASS: own local fixtures/env file removed and child CLI stopped; no hosted changes.');
}
main().catch((error)=>{console.error(`Local discovery check failed: ${error instanceof assert.AssertionError?error.message:'Check local Docker migrations and Edge Runtime setup.'}`);process.exitCode=1;});
