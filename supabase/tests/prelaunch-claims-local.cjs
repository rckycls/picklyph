// T54 on local Docker Supabase + the actual Edge Runtime. Never loads hosted/mobile env.
// A registration made through the T53 command is checked and redeemed through the shipped mobile client and the real
// owner-submissions handler (real Auth, Storage and RPCs), then approved by an admin through the T17 command.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const load = require('./load-ts.cjs');
const { hashClaimCode, CLAIM_CODE_ALPHABET } = require('../../packages/domain/src/claimCode.ts');
// The shipped mobile client (type-only imports) drives the real handler below.
const { checkClaimCode, submitOwner } = require('../../src/features/owner/ownerClient.ts');

const root = path.resolve(__dirname, '../..');
const handlerModule = load(path.join(root, 'supabase/functions/owner-submissions/handler.ts'), {}, { AbortSignal, FormData, Blob });
const { createSupabaseOwnerDeps } = load(path.join(root, 'supabase/functions/owner-submissions/deps.ts'), { './handler.ts': handlerModule });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const photo = { uri: 'file:///proof.jpg', name: 'evidence.jpg', type: 'image/jpeg', size: JPEG.length };
const code = () => Array.from(randomBytes(10), (byte) => CLAIM_CODE_ALPHABET[byte % CLAIM_CODE_ALPHABET.length]).join('');

async function main() {
  const dockerPath = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
  const docker = fs.existsSync(dockerPath) ? dockerPath : 'docker';
  const run = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000 });
  const context = run(['context', 'show']).trim();
  const host = process.env.DOCKER_HOST || run(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://') || host.startsWith('unix://'), 'Requires a local Docker engine.');
  assert.equal(run(['inspect', 'supabase_db_picklyph', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}']).trim(), 'picklyph');
  const psql = (sql) => run(['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], sql).trim();
  run(['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-o', '/dev/null'],
    fs.readFileSync(path.join(__dirname, 'prelaunch-claims.sql'), 'utf8'));
  console.log('PASS: Docker PostgreSQL claim suite (grants, lockout, redemption, refusals, reviewer contacts, sweep); fixtures rolled back.');

  const cli = path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }));
  const api = new URL(config.API_URL);
  assert.ok(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname) && api.port === '54321', 'Requires loopback Supabase.');
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) } };
  const service = createClient(api.href, config.SERVICE_ROLE_KEY, options);
  const anonymous = createClient(api.href, config.ANON_KEY, options);
  const clients = [0, 1, 2, 3].map(() => createClient(api.href, config.ANON_KEY, options));
  const check = (result, message) => { assert.ok(!result.error, `${message}: ${result.error?.message ?? ''}`); return result.data; };
  const secret = randomBytes(32).toString('hex');
  const users = []; const emails = []; const sessions = []; const requestKeys = []; let child; let draftId = null;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pickly-claims-'));
  const objects = async (userId) => (check(await service.storage.from('owner-evidence').list(userId), 'List evidence (service)') ?? []).length;
  try {
    // Claimant (registration email), a locked-out account, a second claimant and an admin reviewer.
    for (const client of clients) {
      const credentials = { email: `claim-${randomUUID()}@example.test`, password: `Local-${randomUUID()}!` };
      users.push(check(await service.auth.admin.createUser({ ...credentials, email_confirm: true }), 'Fixture user').user.id);
      emails.push(credentials.email);
      sessions.push(check(await client.auth.signInWithPassword(credentials), 'Fixture login').session);
    }
    const [claimantId, lockedId, secondId, adminId] = users;
    psql(`insert into private.account_roles(user_id, role) values ('${adminId}', 'admin')`);

    // A pre-launch registration through the T53 command, with a code this run knows.
    const claimCode = code();
    const latitude = Number((6 + Math.random()).toFixed(5)); const longitude = Number((120.5 + Math.random()).toFixed(5));
    const requestKey = randomUUID(); requestKeys.push(requestKey);
    const registered = check(await service.rpc('prelaunch_register', { request_key: requestKey, code_hash: await hashClaimCode(secret, claimCode),
      acknowledge_duplicates: true, registration: { owner_name: 'Local Registrant', email: emails[0], phone: '+639171234567', role: 'owner',
        venue: { name: `Local Claim Courts ${requestKey.slice(0, 8)}`, address_line: '12 Mabini St', city: 'Claimtown', province: 'Sulu', latitude, longitude, court_count: 2 },
        courts: { indoor: false, covered: true, surface: 'hard' }, note: 'Gate on Mabini St.', consent: true } }), 'Registration');
    assert.equal(registered.outcome, 'created');
    draftId = psql(`select venue_id from private.venue_registrations where request_key = '${requestKey}'`);
    const unchanged = () => psql(`select status || ':' || (code_hash is not null) || ':' || (select count(*) from private.venue_submissions s where s.venue_id = r.venue_id)
      || ':' || (select count(*) from private.claim_code_failures f where f.user_id in ('${claimantId}','${lockedId}','${secondId}')) from private.venue_registrations r where r.request_key = '${requestKey}'`);
    assert.equal(unchanged(), 'open:true:0:0');

    // Part A: the actual served function with NO Redis configuration (locked outage policy), secret set.
    const envPath = path.join(temp, 'function.env');
    fs.writeFileSync(envPath, ['DISCOVERY_SUPABASE_URL=http://kong:8000', `DISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}`,
      `DISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}`, 'PICKLY_ENV=local', `PRELAUNCH_CODE_SECRET=${secret}`].join('\n'), { mode: 0o600 });
    child = spawn(cli, ['functions', 'serve', 'owner-submissions', '--env-file', envPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let served = '';
    child.stdout.on('data', (chunk) => { served += chunk; }); child.stderr.on('data', (chunk) => { served += chunk; });
    let launchError = false; child.on('error', () => { launchError = true; });
    const endpoint = new URL('functions/v1/owner-submissions', api).href;
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      assert.ok(!launchError && child.exitCode === null, 'Own local Edge server must remain running.');
      try { if ((await fetch(`${endpoint}?address=Manila`, { headers: { apikey: config.ANON_KEY }, signal: AbortSignal.timeout(8000) })).status === 401) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'Local owner endpoint must become ready.');
    const servedTransport = { endpoint, apiKey: config.ANON_KEY, accessToken: async () => sessions[0].access_token,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }), evidencePart: () => new Blob([JPEG]) };
    const forged = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ code: claimCode }),
      headers: { apikey: config.ANON_KEY, authorization: 'Bearer forged', 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000) });
    assert.equal(forged.status, 401, 'forged token');
    const servedCheck = await checkClaimCode(servedTransport, claimCode);
    assert.equal(servedCheck.ok, false); assert.equal(servedCheck.failure.kind, 'unavailable', 'code checks fail closed without Redis');
    const servedRedeem = await submitOwner(servedTransport, { kind: 'registration', request_id: randomUUID(), code: claimCode, note: null }, photo);
    assert.equal(servedRedeem.ok, false); assert.equal(servedRedeem.failure.kind, 'unavailable', 'redemptions fail closed without Redis');
    assert.equal(unchanged(), 'open:true:0:0', 'nothing written or counted');
    assert.equal(await objects(claimantId), 0, 'no evidence stored');
    assert.ok(!served.includes(claimCode) && !served.includes(`${claimCode.slice(0, 5)}-${claimCode.slice(5)}`), 'the code never reaches the function log');
    console.log('PASS: actual local Edge Runtime: forged JWT 401; code check and redemption 503 without Redis; nothing written, counted or stored; no code in logs.');

    // Part B: the same handler with real local Auth, Storage and RPCs, an allowing limiter and the secret.
    const verifier = () => createClient(api.href, config.ANON_KEY, options);
    const server = () => createClient(api.href, config.SERVICE_ROLE_KEY, options);
    const build = (hashCode) => handlerModule.createOwnerHandler({
      ...createSupabaseOwnerDeps(verifier, server),
      limit: async () => ({ allowed: true, status: 200, state: 'enforced', headers: {} }),
      geocode: null, hashCode, newId: () => randomUUID(),
    });
    const handler = build((value) => hashClaimCode(secret, value));
    const transport = (session, target = handler) => ({ endpoint: 'https://owner.local/functions/v1/owner-submissions', apiKey: config.ANON_KEY,
      accessToken: async () => session.access_token, fetch: (url, init) => target(new Request(url, init)), evidencePart: () => new Blob([JPEG]) });

    // Without the secret nothing is checked or written.
    const unconfigured = build(null);
    assert.equal((await checkClaimCode(transport(sessions[0], unconfigured), claimCode)).failure?.kind, 'unavailable');
    assert.equal((await submitOwner(transport(sessions[0], unconfigured), { kind: 'registration', request_id: randomUUID(), code: claimCode, note: null }, photo)).failure?.kind, 'unavailable');
    assert.equal(unchanged(), 'open:true:0:0'); assert.equal(await objects(claimantId), 0);

    // Lockout: four wrong codes, then a wrong redemption locks the account; then even the right code is refused.
    for (let n = 0; n < 4; n++) {
      assert.deepEqual(await checkClaimCode(transport(sessions[1]), code()), { ok: false, failure: { kind: 'rejected', reason: 'code_not_valid', retryAfterSeconds: null } });
    }
    const locking = await submitOwner(transport(sessions[1]), { kind: 'registration', request_id: randomUUID(), code: code(), note: null }, photo);
    assert.equal(locking.ok, false); assert.equal(locking.failure.kind, 'code_locked'); assert.ok(locking.failure.retryAfterSeconds > 3500, 'locked for an hour');
    const lockedRight = await checkClaimCode(transport(sessions[1]), claimCode);
    assert.equal(lockedRight.failure?.kind, 'code_locked', 'a locked account is refused even the right code');
    assert.equal(await objects(lockedId), 0, 'refused redemptions leave no evidence');
    assert.equal(psql(`select failures || ':' || (locked_until > now()) from private.claim_code_failures where user_id = '${lockedId}'`), '5:true');

    // The claimant sees the venue, then redeems with proof; a lost reply's retry returns the original.
    const preview = await checkClaimCode(transport(sessions[0]), `${claimCode.slice(0, 5).toLowerCase()}-${claimCode.slice(5)}`);
    assert.ok(preview.ok); assert.deepEqual({ ...preview.value }, { name: `Local Claim Courts ${requestKey.slice(0, 8)}`, address_line: '12 Mabini St', city: 'Claimtown', province: 'Sulu', court_count: 2 });
    const redemption = { kind: 'registration', request_id: randomUUID(), code: claimCode, note: 'I run the venue.' };
    const created = await submitOwner(transport(sessions[0]), redemption, photo);
    assert.ok(created.ok && created.value.status === 'created', 'redeemed');
    assert.equal(created.value.submission.venue_id, draftId, 'the registration draft became the submission');
    const retry = await submitOwner(transport(sessions[0]), redemption, photo);
    assert.ok(retry.ok && retry.value.status === 'existing' && retry.value.submission.id === created.value.submission.id, 'retry returns the original');
    assert.equal(await objects(claimantId), 1, 'one stored proof; the retry upload was removed');
    assert.equal(psql(`select r.status || ':' || (r.code_hash is null) || ':' || r.claim_email_matched || ':' || v.publication_status || ':' || v.claim_status
      from private.venue_registrations r join public.venues v on v.id = r.venue_id where r.request_key = '${requestKey}'`), 'claimed:true:true:draft:pending');
    assert.equal(psql(`select count(*) from private.ownership_audit_events where action = 'registration.claim' and actor_user_id = '${claimantId}' and target_venue_id = '${draftId}'`), '1');
    const access = check(await clients[0].rpc('my_account_access'), 'Own access')[0];
    assert.deepEqual([access.owned_venue_ids, access.pending_venue_ids], [[], [draftId]], 'the claimant sets the draft up under review');
    assert.equal(check(await anonymous.from('venues').select('id').eq('id', draftId), 'Public draft read').length, 0, 'still private');
    // The spent code is refused to everyone else, in the same words as a wrong one.
    assert.deepEqual(await checkClaimCode(transport(sessions[2]), claimCode), { ok: false, failure: { kind: 'rejected', reason: 'code_not_valid', retryAfterSeconds: null } });
    const stolen = await submitOwner(transport(sessions[2]), { ...redemption, request_id: randomUUID() }, photo);
    assert.deepEqual(stolen, { ok: false, failure: { kind: 'rejected', reason: 'code_not_valid', retryAfterSeconds: null } });
    assert.equal(await objects(secondId), 0);

    // Clients can't call the commands or read registrations directly.
    for (const [client, label] of [[clients[0], 'claimant'], [clients[2], 'other account'], [anonymous, 'guest']]) {
      const direct = await client.rpc('owner_redeem_registration', { actor_user_id: claimantId, submission_request_id: randomUUID(),
        code_hash: await hashClaimCode(secret, claimCode), evidence_ref: 'x', submission_note: null });
      assert.equal(direct.error?.code, '42501', `${label} cannot redeem directly`);
      assert.equal((await client.rpc('owner_registration_check', { actor_user_id: claimantId, code_hash: '0'.repeat(64) })).error?.code, '42501', `${label} cannot check directly`);
    }

    // Review: the admin sees the registration with its contacts and approves; the claimant becomes the owner.
    const item = check(await service.rpc('ownership_review_read', { actor_user_id: adminId, subject_id: created.value.submission.id }), 'Review read');
    assert.equal(item.registration.role, 'owner'); assert.equal(item.registration.email_matched, true);
    assert.deepEqual(item.registration.contact, { owner_name: 'Local Registrant', email: emails[0], phone: '+639171234567', note: 'Gate on Mabini St.' });
    const queue = check(await service.rpc('ownership_review_queue', { actor_user_id: adminId }), 'Queue');
    assert.equal(queue.items.find((row) => row.id === created.value.submission.id)?.prelaunch, true, 'queue marks it pre-launch');
    const decided = check(await service.rpc('ownership_review_decide', { actor_user_id: adminId, subject_id: created.value.submission.id,
      decision: 'approve', target_venue_id: null, rejection_reason: null }), 'Approve');
    assert.equal(decided.outcome, 'decided');
    assert.equal(check(await anonymous.from('venues').select('claim_status').eq('id', draftId).single(), 'Public venue').claim_status, 'verified', 'published and verified');
    assert.deepEqual(check(await clients[0].rpc('my_account_access'), 'Own access')[0].owned_venue_ids, [draftId], 'the claimant owns it');
    console.log('PASS: real handler + local Auth/Storage/RPC via the shipped mobile client: no secret 503; 5 wrong codes lock (right code refused); check shows the venue; redemption with proof turns the draft into a pending submission; lost-reply retry returns the original; spent code refused to others; direct RPCs 42501; admin sees contacts and approval publishes and links.');
  } finally {
    if (child && child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve)); child.kill();
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    let clean = true;
    const steps = [];
    for (const userId of users) {
      steps.push(async () => {
        const files = check(await service.storage.from('owner-evidence').list(userId), 'List own evidence') ?? [];
        if (files.length) check(await service.storage.from('owner-evidence').remove(files.map((file) => `${userId}/${file.name}`)), 'Own evidence cleanup');
      });
    }
    for (const userId of users) steps.push(() => service.auth.admin.deleteUser(userId).then((r) => check(r, 'Own user cleanup')));
    // Registrations hold the draft; audit rows (no FK) name the users, the registration or the draft.
    if (requestKeys.length) {
      const keys = requestKeys.map((key) => `'${key}'`).join(',');
      const ids = users.map((id) => `'${id}'`).join(',') || 'null';
      steps.push(() => psql(`begin;
        create temporary table own_venues on commit drop as select id as registration_id, venue_id from private.venue_registrations where request_key in (${keys});
        delete from private.directory_audit_events where target_venue_id in (select venue_id from own_venues) or actor_user_id in (${ids});
        delete from private.ownership_audit_events where target_venue_id in (select venue_id from own_venues) or actor_user_id in (${ids});
        delete from private.venue_registrations where request_key in (${keys});
        delete from public.venues where id in (select venue_id from own_venues);
        commit;`));
    }
    steps.push(() => {
      assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()), 'Cleanup target must remain in the intended temp directory.');
      assert.match(path.basename(temp), /^pickly-claims-/, 'Cleanup target must be this test’s directory.');
      fs.rmSync(temp, { recursive: true, force: true });
    });
    for (const client of [service, anonymous, ...clients]) steps.push(() => client.auth.stopAutoRefresh());
    for (const step of steps) { try { await step(); } catch { clean = false; } }
    if (users.length) {
      const ids = users.map((id) => `'${id}'`).join(',');
      try {
        assert.equal(psql(`select (select count(*) from private.venue_submissions where submitter_user_id in (${ids}))
          + (select count(*) from private.claim_code_failures where user_id in (${ids}))
          + (select count(*) from private.account_roles where user_id in (${ids}))
          + (select count(*) from private.venue_owners where user_id in (${ids}))
          + (select count(*) from private.ownership_audit_events where actor_user_id in (${ids}))
          + (select count(*) from private.venue_registrations where request_key in (${requestKeys.map((key) => `'${key}'`).join(',') || 'null'}))
          + (select count(*) from public.venues where id = ${draftId ? `'${draftId}'` : 'null'})
          + (select count(*) from storage.objects where bucket_id = 'owner-evidence' and split_part(name, '/', 1) in (${ids}))`), '0');
      } catch { clean = false; }
    }
    assert.ok(clean, 'Own local fixtures, evidence, audit rows and temporary credential file must be removed.');
  }
  console.log('PASS: own local accounts, registration, draft, evidence, audit rows and env file removed; child CLI stopped; no hosted changes.');
}
main().catch((error) => { console.error(`Local claim check failed: ${error instanceof assert.AssertionError ? error.message : 'Check local Docker migrations, Storage and Edge Runtime setup.'}`); process.exitCode = 1; });
