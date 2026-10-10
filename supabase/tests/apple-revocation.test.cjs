// T50a: the shared Sign in with Apple client against a scripted fake of Apple's endpoints (never the real Apple service).
const assert=require('node:assert/strict');const path=require('node:path');const {test}=require('node:test');const load=require('./load-ts.cjs');
const apple=load(path.join(__dirname,'../functions/_shared/apple.ts'),{},{TextDecoder,atob,btoa});
const {createAppleRevocation,readAppleConfig,APPLE_ORIGIN,CLIENT_SECRET_SECONDS}=apple;
const plain=value=>JSON.parse(JSON.stringify(value));
const b64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const subject='001234.0f1e2d3c4b5a69788796a5b4c3d2e1f0.0412';const clientId='com.rckycls.picklyph';
const idToken=(claims={})=>`${b64({alg:'RS256',kid:'apple'})}.${b64({iss:APPLE_ORIGIN,aud:clientId,sub:subject,iat:1,exp:2,...claims})}.signature`;
async function keyPair(){
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const der=Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64');
  return {pair,pem:`-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`};
}
// Scripted fake Apple: records each call and answers from the plan for its path.
function fakeApple(plan){
  const calls=[];
  const request=async(url,init)=>{calls.push({url,method:init.method,redirect:init.redirect,type:init.headers['Content-Type'],form:Object.fromEntries(new URLSearchParams(init.body))});
    const [status,body]=plan[new URL(url).pathname]();return new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers:{'content-type':'application/json'}});};
  return {calls,request};
}
const env=values=>name=>values[name];

test('configuration needs all four Apple settings in their documented shapes, or it is missing (fail closed)',async()=>{
  const {pem}=await keyPair();const full={APPLE_TEAM_ID:'ABCDE12345',APPLE_KEY_ID:'KEY0123456',APPLE_CLIENT_ID:clientId,APPLE_PRIVATE_KEY:pem};
  assert.deepEqual(plain(readAppleConfig(env(full))),{teamId:'ABCDE12345',keyId:'KEY0123456',clientId,privateKey:pem.trim()});
  for(const name of Object.keys(full))assert.equal(readAppleConfig(env({...full,[name]:undefined})),null,`${name} missing`);
  for(const [name,value] of [['APPLE_TEAM_ID','abcde12345'],['APPLE_TEAM_ID','ABCDE1234'],['APPLE_KEY_ID','KEY 012345'],['APPLE_CLIENT_ID','picklyph'],
    ['APPLE_CLIENT_ID','com.rckycls.picklyph/'],['APPLE_PRIVATE_KEY','not a key'],['APPLE_PRIVATE_KEY','   ']])
    assert.equal(readAppleConfig(env({...full,[name]:value})),null,`${name}=${value}`);
});

test('every Apple call carries a fresh ES256 client secret for this team, key and bundle that verifies with the key pair',async()=>{
  const {pair,pem}=await keyPair();let clock=Date.parse('2026-10-11T00:00:00Z');
  const fake=fakeApple({'/auth/token':()=>[200,{access_token:'access-1',token_type:'Bearer',expires_in:3600,refresh_token:'refresh-1',id_token:idToken()}],'/auth/revoke':()=>[200,'']});
  // Secret stores often keep the PEM on one line with literal \n.
  const client=createAppleRevocation({teamId:'ABCDE12345',keyId:'KEY0123456',clientId,privateKey:pem.replace(/\n/g,'\\n')},fake.request,()=>clock);
  const grant=await client.exchange('code-123456');
  assert.deepEqual(plain(grant),{subject,token:'refresh-1',hint:'refresh_token'},'the refresh token ends the whole authorization');
  clock+=60000;await client.revoke(grant);
  assert.deepEqual(fake.calls.map(c=>[c.url,c.method,c.redirect,c.type]),[[`${APPLE_ORIGIN}/auth/token`,'POST','error','application/x-www-form-urlencoded'],
    [`${APPLE_ORIGIN}/auth/revoke`,'POST','error','application/x-www-form-urlencoded']]);
  const {client_secret:first,...exchange}=fake.calls[0].form;const {client_secret:second,...revoke}=fake.calls[1].form;
  assert.deepEqual(exchange,{client_id:clientId,grant_type:'authorization_code',code:'code-123456'});
  assert.deepEqual(revoke,{client_id:clientId,token:'refresh-1',token_type_hint:'refresh_token'});
  for(const [secret,at] of [[first,Date.parse('2026-10-11T00:00:00Z')],[second,Date.parse('2026-10-11T00:01:00Z')]]){
    const [head,body,signature]=secret.split('.');const iat=at/1000;
    assert.deepEqual(JSON.parse(Buffer.from(head,'base64url')),{alg:'ES256',kid:'KEY0123456'});
    assert.deepEqual(JSON.parse(Buffer.from(body,'base64url')),{iss:'ABCDE12345',iat,exp:iat+CLIENT_SECRET_SECONDS,aud:'https://appleid.apple.com',sub:clientId});
    assert.equal(Buffer.from(signature,'base64url').length,64,'JWS ES256 is raw r||s');
    assert.ok(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pair.publicKey,Buffer.from(signature,'base64url'),Buffer.from(`${head}.${body}`)),'signature verifies');
  }
  assert.notEqual(first,second,'each call signs a new secret');assert.equal(CLIENT_SECRET_SECONDS,300);
  const other=await keyPair();const [h,b,s]=first.split('.');
  assert.equal(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},other.pair.publicKey,Buffer.from(s,'base64url'),Buffer.from(`${h}.${b}`)),false,'control: another key does not verify');
});

test('exchange: invalid_grant is a refused code; other failures and unexpected ID tokens throw; the access token is the fallback',async()=>{
  const {pem}=await keyPair();const config={teamId:'ABCDE12345',keyId:'KEY0123456',clientId,privateKey:pem};
  const exchange=async reply=>createAppleRevocation(config,fakeApple({'/auth/token':()=>reply}).request).exchange('code-123456');
  assert.equal(await exchange([400,{error:'invalid_grant',error_description:'The code has expired or has been revoked.'}]),null);
  for(const reply of [[400,{error:'invalid_client'}],[400,{error:'invalid_request'}],[500,{}],[503,'down'],[200,'not json'],[200,{refresh_token:'r'}],
    [200,{refresh_token:'r',id_token:idToken({iss:'https://evil.example'})}],[200,{refresh_token:'r',id_token:idToken({aud:'com.other.app'})}],
    [200,{refresh_token:'r',id_token:idToken({aud:[clientId]})}],[200,{refresh_token:'r',id_token:idToken({sub:''})}],[200,{refresh_token:'r',id_token:idToken({sub:42})}],
    [200,{refresh_token:'r',id_token:'one-part'}],[200,{id_token:idToken()}],[200,{refresh_token:'',access_token:'',id_token:idToken()}]])
    await assert.rejects(exchange(reply),JSON.stringify(reply));
  assert.deepEqual(plain(await exchange([200,{access_token:'access-only',id_token:idToken()}])),{subject,token:'access-only',hint:'access_token'});
  const network=createAppleRevocation(config,async()=>{throw new Error('offline');});await assert.rejects(network.exchange('code-123456'));
  await assert.rejects(createAppleRevocation({...config,privateKey:'-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----'},fakeApple({}).request).exchange('code-123456'),
    'a broken key fails before any request');
});

test('revoke: only a 200 from Apple counts as revoked',async()=>{
  const {pem}=await keyPair();const config={teamId:'ABCDE12345',keyId:'KEY0123456',clientId,privateKey:pem};
  const grant={subject,token:'refresh-1',hint:'refresh_token'};
  await createAppleRevocation(config,fakeApple({'/auth/revoke':()=>[200,'']}).request).revoke(grant);
  for(const reply of [[400,{error:'invalid_client'}],[500,''],[503,'']])
    await assert.rejects(createAppleRevocation(config,fakeApple({'/auth/revoke':()=>reply}).request).revoke(grant),JSON.stringify(reply));
  await assert.rejects(createAppleRevocation(config,async()=>{throw new Error('timeout');}).revoke(grant));
});
