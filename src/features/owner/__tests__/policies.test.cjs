const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');
const { readPolicySave } = require('../../../../packages/domain/src/policy.ts');
const { loadVenuePolicy, saveVenuePolicy, parseVenuePolicy } = require('../venueClient.ts');
const { initialMode, checkingMode, checkedMode, chooseMode } = require('../modeState.ts');
const { createVenueHandler, CommandRejected } = load(path.resolve(path.dirname(module.filename),'../../../../supabase/functions/owner-venues/handler.ts'),{},{TextDecoder});
const VENUE='72000000-0000-4000-8000-000000000001';
const command={kind:'save_policy',venue_id:VENUE,expected_revision:'0',policy:{confirmation:'approval',payment:'arrival'}};
const plain = x => JSON.parse(JSON.stringify(x));
test('strict policy contract excludes merchant activation/actor and rejects invalid versions and choices',()=>{
  assert.deepEqual(readPolicySave(command),command);
  for(const body of [{...command,actor_user_id:'spoof'},{...command,merchant_active:true},{...command,expected_revision:0},
    {...command,expected_revision:'01'},{...command,policy:{...command.policy,merchant_active:true}},
    {...command,policy:{confirmation:'instant',payment:'cash'}},{...command,policy:{confirmation:null,payment:'arrival'}}]) assert.throws(()=>readPolicySave(body));
  assert.throws(()=>parseVenuePolicy({venue_id:VENUE,revision:'1',confirmation:'instant',payment:'online',merchant_active:false}));
});
test('owner mode clears revoked/error eligibility and ignores stale identity/generation responses',()=>{
  let state=checkingMode(initialMode('owner'));
  state=checkedMode(state,'owner',state.generation,2); state=chooseMode(state,'owner'); assert.equal(state.mode,'owner');
  const oldGeneration=state.generation;state=checkingMode(state);assert.equal(state.count,null);
  assert.equal(checkedMode(state,'other',state.generation,5),state);
  assert.equal(checkedMode(state,'owner',oldGeneration,5),state);
  state=checkedMode(state,'owner',state.generation,0);assert.equal(state.mode,'player');
  assert.equal(chooseMode(state,'owner').mode,'player');
  state=checkedMode(checkingMode(state),'owner',state.generation+1,null);assert.equal(state.mode,'player');assert.equal(state.error,true);
  const next=initialMode('next-account');assert.equal(next.mode,'player');assert.equal(next.count,null);
});
test('shipped client/handler policies verify actor, reuse limits, map conflicts/activation and reject spoofing',async()=>{
  const seen=[];let active=false;let revision=0;
  const view=()=>({venue_id:VENUE,revision:String(revision),confirmation:'instant',payment:'arrival',merchant_active:active});
  let denied=false;
  const handler=createVenueHandler({verifyUser:async token=>token==='real'?'verified-actor':null,
    limit:async(action,principal)=>{seen.push([action,principal]);return denied?{allowed:false,status:503,headers:{'Retry-After':'5'}}:{allowed:true,headers:{}};},
    readPolicy:async actor=>{assert.equal(actor,'verified-actor');return view();},
    savePolicy:async(actor,c)=>{assert.equal(actor,'verified-actor');if(c.expected_revision!==String(revision))throw new CommandRejected('version_conflict');
      if(c.policy.payment!=='arrival'&&!active)throw new CommandRejected('merchant_inactive');revision++;return {...view(),...c.policy};}});
  const transport={endpoint:'https://local/owner-venues',apiKey:'public',accessToken:async()=> 'real',fetch:(url,init)=>handler(new Request(url,init))};
  assert.equal((await loadVenuePolicy(transport,VENUE)).value.revision,'0');
  assert.equal((await saveVenuePolicy(transport,{...command,policy:{confirmation:'instant',payment:'online'}})).failure.reason,'merchant_inactive');
  assert.equal((await saveVenuePolicy(transport,command)).value.revision,'1');
  assert.equal((await saveVenuePolicy(transport,command)).failure.reason,'version_conflict');
  denied=true;assert.equal((await saveVenuePolicy(transport,{...command,expected_revision:'1'})).failure.kind,'unavailable');assert.equal(revision,1);
  denied=false;active=true;assert.equal((await saveVenuePolicy(transport,{...command,expected_revision:'1',policy:{confirmation:'instant',payment:'both'}})).value.payment,'both');
  const post=body=>handler(new Request(transport.endpoint,{method:'POST',headers:{authorization:'Bearer real','content-type':'application/json'},body:JSON.stringify(body)}));
  assert.equal((await post({...command,actor_user_id:'spoof'})).status,400);
  assert.equal((await post({...command,policy:{...command.policy,merchant_active:true}})).status,400);
  assert.equal((await handler(new Request(transport.endpoint,{headers:{authorization:'Bearer forged'}}))).status,401);
  assert.equal((await handler(new Request(transport.endpoint+'?venue_id='+VENUE+'&section=policies&section=policies',{headers:{authorization:'Bearer real'}}))).status,400);
  assert.deepEqual(plain(seen[0]),['owner-read',{kind:'user',id:'verified-actor'}]);
});
