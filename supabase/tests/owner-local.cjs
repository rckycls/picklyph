// Local Docker Supabase + actual Edge Runtime. Never loads hosted/mobile env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const load = require('./load-ts.cjs');
// The shipped mobile client (type-only imports) drives the real handler below.
const { findNearbyListings, submitOwner } = require('../../src/features/owner/ownerClient.ts');

const root = path.resolve(__dirname, '../..');
const handlerModule = load(path.join(root, 'supabase/functions/owner-submissions/handler.ts'), {}, { AbortSignal, FormData, Blob });
const { createSupabaseOwnerDeps } = load(path.join(root, 'supabase/functions/owner-submissions/deps.ts'), { './handler.ts': handlerModule });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

async function main() {
  const dockerPath = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
  const docker = fs.existsSync(dockerPath) ? dockerPath : 'docker';
  const run = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });
  const context = run(['context', 'show']).trim();
  const host = process.env.DOCKER_HOST || run(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://') || host.startsWith('unix://'), 'Requires a local Docker engine.');
  assert.equal(run(['inspect', 'supabase_db_picklyph', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}']).trim(), 'picklyph');
  const psql = (sql) => run(['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], sql).trim();
  run(['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-o', '/dev/null'],
    fs.readFileSync(path.join(__dirname, 'owner.sql'), 'utf8'));
  console.log('PASS: Docker PostgreSQL + Storage schema owner suite (isolation, evidence, duplicates, retries, cap, audit); fixtures rolled back.');

  const cli = path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }));
  const api = new URL(config.API_URL);
  assert.ok(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname) && api.port === '54321', 'Requires loopback Supabase.');
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) } };
  const service = createClient(api.href, config.SERVICE_ROLE_KEY, options);
  const anonymous = createClient(api.href, config.ANON_KEY, options);
  const owner = createClient(api.href, config.ANON_KEY, options);
  const other = createClient(api.href, config.ANON_KEY, options);
  const check = (result, message) => { assert.ok(!result.error, message); return result.data; };
  const venueId = randomUUID();
  // A random spot in the Sulu Sea area keeps this run's duplicates to its own fixture.
  const latitude = Number((6 + Math.random()).toFixed(5)); const longitude = Number((120.5 + Math.random()).toFixed(5));
  const users = []; let venueCreated = false; let child;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pickly-owner-'));
  const objects = async (userId) => (check(await service.storage.from('owner-evidence').list(userId), 'List evidence (service)') ?? []).length;
  try {
    check(await service.from('venues').insert({ id: venueId, name: `Local Owner Fixture ${venueId.slice(0, 8)}`, address_line: 'Fixture address',
      city: 'Fixture City', province: 'Fixture', latitude, longitude, publication_status: 'approved' }), 'Fixture venue');
    venueCreated = true;
    check(await service.from('courts').insert({ venue_id: venueId, name: 'Court 1', surface: 'hard' }), 'Fixture court');
    const sessions = [];
    for (const client of [owner, other]) {
      const credentials = { email: `owner-${randomUUID()}@example.test`, password: `Local-${randomUUID()}!` };
      users.push(check(await service.auth.admin.createUser({ ...credentials, email_confirm: true }), 'Fixture user').user.id);
      sessions.push(check(await client.auth.signInWithPassword(credentials), 'Fixture login').session);
    }
    const [ownerId, otherId] = users;

    // Part A: the actual served function with NO Redis configuration (locked outage policy).
    const envPath = path.join(temp, 'function.env');
    fs.writeFileSync(envPath, ['DISCOVERY_SUPABASE_URL=http://kong:8000', `DISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}`,
      `DISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}`, 'PICKLY_ENV=local'].join('\n'), { mode: 0o600 });
    child = spawn(cli, ['functions', 'serve', 'owner-submissions', '--env-file', envPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let launchError = false; child.on('error', () => { launchError = true; });
    const endpoint = new URL('functions/v1/owner-submissions', api).href;
    const call = (init = {}, query = 'address=Manila') => fetch(`${endpoint}?${query}`, { ...init, headers: { apikey: config.ANON_KEY, ...init.headers }, signal: AbortSignal.timeout(8000) });
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      assert.ok(!launchError && child.exitCode === null, 'Own local Edge server must remain running.');
      try { if ((await call()).status === 401) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'Local owner endpoint must become ready.');
    assert.equal((await call({ headers: { authorization: 'Bearer forged' } })).status, 401, 'forged token');
    const forged = `${sessions[0].access_token.split('.')[0]}.${Buffer.from(JSON.stringify({ sub: ownerId, role: 'authenticated', exp: 9999999999 })).toString('base64url')}.forged`;
    assert.equal((await call({ headers: { authorization: `Bearer ${forged}` } })).status, 401, 'forged user ID fails actual getUser');
    const lookup = await call({ headers: { authorization: `Bearer ${sessions[0].access_token}` } });
    assert.equal(lookup.status, 503, 'owner lookups stop when the limiter is unavailable');
    const servedTransport = { endpoint, apiKey: config.ANON_KEY, accessToken: async () => sessions[0].access_token,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }), evidencePart: () => new Blob([JPEG]) };
    const claim = { kind: 'claim', request_id: randomUUID(), venue_id: venueId, note: null };
    const refused = await submitOwner(servedTransport, claim, { uri: 'x', name: 'evidence.jpg', type: 'image/jpeg', size: JPEG.length });
    assert.equal(refused.ok, false); assert.equal(refused.failure.kind, 'unavailable', 'creation fails closed with 503');
    assert.equal(await objects(ownerId), 0, 'no evidence stored during a limiter outage');
    assert.equal(check(await owner.rpc('my_owner_submissions'), 'Own list').length, 0, 'no claim stored during a limiter outage');
    console.log('PASS: actual local Edge Runtime: sign-in required, forged JWT 401, Redis-unavailable lookups/submissions 503 with no storage or database change.');

    // Part B: the same handler with real local Auth, Storage and RPCs, and an allowing limiter.
    const verifier = () => createClient(api.href, config.ANON_KEY, options);
    const server = () => createClient(api.href, config.SERVICE_ROLE_KEY, options);
    const handler = handlerModule.createOwnerHandler({
      ...createSupabaseOwnerDeps(verifier, server),
      limit: async () => ({ allowed: true, status: 200, state: 'enforced', headers: {} }),
      geocode: null, newId: () => randomUUID(),
    });
    const transport = (session) => ({ endpoint: 'https://owner.local/functions/v1/owner-submissions', apiKey: config.ANON_KEY,
      accessToken: async () => session.access_token, fetch: (url, init) => handler(new Request(url, init)), evidencePart: () => new Blob([JPEG]) });
    const photo = { uri: 'file:///proof.jpg', name: 'evidence.jpg', type: 'image/jpeg', size: JPEG.length };
    const created = await submitOwner(transport(sessions[0]), claim, photo);
    assert.ok(created.ok && created.value.status === 'created' && created.value.submission.venue_id === venueId, 'claim created');
    assert.equal(await objects(ownerId), 1, 'evidence stored privately');
    const retry = await submitOwner(transport(sessions[0]), claim, photo);
    assert.ok(retry.ok && retry.value.status === 'existing' && retry.value.submission.id === created.value.submission.id, 'retry returns original');
    const again = await submitOwner(transport(sessions[0]), { ...claim, request_id: randomUUID() }, photo);
    assert.deepEqual(again, { ok: false, failure: { kind: 'rejected', reason: 'already_pending', retryAfterSeconds: null } });
    assert.equal(await objects(ownerId), 1, 'retries/rejections leave no extra evidence');
    const near = await findNearbyListings(transport(sessions[0]), { latitude: latitude + 0.0003, longitude }, null);
    assert.ok(near.ok && near.value.length === 1 && near.value[0].id === venueId && near.value[0].distance_m > 20 && near.value[0].distance_m < 50, 'nearby approved listing');
    const pin = { kind: 'venue', request_id: randomUUID(), note: 'Second building', acknowledge_duplicates: false,
      venue: { name: 'Local Owner New Courts', address_line: 'Next door', city: 'Fixture City', province: 'Fixture', latitude: latitude + 0.0003, longitude, court_count: 2 } };
    const warned = await submitOwner(transport(sessions[0]), pin, photo);
    assert.ok(warned.ok && warned.value.status === 'duplicates' && warned.value.duplicates[0].id === venueId, 'duplicate warning');
    assert.equal(await objects(ownerId), 1, 'warning stores nothing');
    const accepted = await submitOwner(transport(sessions[0]), { ...pin, acknowledge_duplicates: true }, photo);
    assert.ok(accepted.ok && accepted.value.status === 'created' && accepted.value.submission.kind === 'venue', 'acknowledged submission');
    const competing = await submitOwner(transport(sessions[1]), { ...claim, request_id: randomUUID() }, photo);
    assert.ok(competing.ok && competing.value.status === 'created', 'second account may also claim');
    const pdf = await handler(new Request('https://owner.local/functions/v1/owner-submissions', { method: 'POST', headers: { authorization: `Bearer ${sessions[1].access_token}` },
      body: (() => { const form = new FormData(); form.append('submission', JSON.stringify({ ...claim, request_id: randomUUID() })); form.append('evidence', new Blob([new TextEncoder().encode('%PDF-1.7')]), 'a.pdf'); return form; })() }));
    assert.equal(pdf.status, 415, 'non-image evidence refused before storage');
    assert.equal(await objects(ownerId), 2); assert.equal(await objects(otherId), 1);

    const mine = check(await owner.rpc('my_owner_submissions'), 'Own list');
    assert.deepEqual(mine.map((row) => row.kind).sort(), ['claim', 'venue'], 'own claims and submissions only');
    assert.ok(!JSON.stringify(mine).includes('owner-evidence') && !JSON.stringify(mine).includes(ownerId), 'no evidence paths or IDs');
    assert.equal(check(await other.rpc('my_owner_submissions'), 'Other list').length, 1);
    assert.ok((await anonymous.rpc('my_owner_submissions')).error, 'guests cannot list submissions');
    const stored = `${ownerId}/${check(await service.storage.from('owner-evidence').list(ownerId), 'Evidence names')[0].name}`;
    for (const [client, label] of [[owner, 'owner'], [other, 'other account'], [anonymous, 'guest']]) {
      const bucket = client.storage.from('owner-evidence');
      assert.ok((await bucket.download(stored)).error, `${label} cannot download real evidence, even the uploader`);
      const listed = await bucket.list(ownerId);
      assert.ok(listed.error || listed.data.length === 0, `${label} cannot list evidence`);
      assert.ok((await bucket.createSignedUrl(stored, 60)).error, `${label} cannot sign evidence URLs`);
      assert.ok((await bucket.upload(`${ownerId}/${randomUUID()}.jpg`, new Blob([JPEG]), { contentType: 'image/jpeg' })).error, `${label} cannot upload directly`);
      const direct = await client.rpc('owner_submit_claim', { actor_user_id: ownerId, submission_request_id: randomUUID(),
        target_venue_id: venueId, evidence_ref: stored, claim_note: null });
      assert.equal(direct.error?.code, '42501', `${label} cannot call the claim command directly`);
      const preview = await client.rpc('owner_duplicate_candidates', { actor_user_id: ownerId, latitude, longitude, proposed_name: null });
      assert.equal(preview.error?.code, '42501', `${label} cannot call the duplicate check directly`);
    }
    assert.ok(!(await service.storage.from('owner-evidence').download(stored)).error, 'the trusted server can read evidence for review');
    assert.equal(await objects(ownerId), 2, 'direct uploads were refused');
    const listing = check(await anonymous.from('venues').select('claim_status').eq('id', venueId).single(), 'Public listing');
    assert.equal(listing.claim_status, 'unclaimed', 'submissions never change the public listing');
    assert.equal(psql(`select count(*) from private.venue_owners where venue_id = '${venueId}'`), '0', 'no ownership granted');
    assert.equal(psql(`select count(*) from private.ownership_audit_events where actor_user_id in ('${ownerId}','${otherId}')`), '3', 'one audit event per created command');
    console.log('PASS: real handler + local Auth/Storage/RPC via the shipped mobile client: private evidence, retries, duplicate warning/ack, competing claim, 415, self-only list, client storage/RPC denial, public listing unchanged.');
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
    if (venueCreated) steps.push(() => service.from('venues').delete().eq('id', venueId).then((r) => check(r, 'Own venue cleanup')));
    for (const userId of users) steps.push(() => service.auth.admin.deleteUser(userId).then((r) => check(r, 'Own user cleanup')));
    // Audit history deliberately survives account deletion (no FK); remove only this run's synthetic events.
    if (users.length) steps.push(() => psql(`delete from private.ownership_audit_events where actor_user_id in (${users.map((id) => `'${id}'`).join(',')})`));
    steps.push(() => {
      assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()), 'Cleanup target must remain in the intended temp directory.');
      assert.match(path.basename(temp), /^pickly-owner-/, 'Cleanup target must be this test’s directory.');
      fs.rmSync(temp, { recursive: true, force: true });
    });
    for (const client of [service, anonymous, owner, other]) steps.push(() => client.auth.stopAutoRefresh());
    for (const step of steps) { try { await step(); } catch { clean = false; } }
    if (users.length) {
      const ids = users.map((id) => `'${id}'`).join(',');
      try {
        assert.equal(psql(`select (select count(*) from private.venue_claims where claimant_user_id in (${ids}))
          + (select count(*) from private.venue_submissions where submitter_user_id in (${ids}))
          + (select count(*) from private.ownership_audit_events where actor_user_id in (${ids}))
          + (select count(*) from storage.objects where bucket_id = 'owner-evidence' and split_part(name, '/', 1) in (${users.map((id) => `'${id}'`).join(',')}))`), '0');
      } catch { clean = false; }
    }
    assert.ok(clean, 'Own local fixtures, evidence and temporary credential file must be removed.');
  }
  console.log('PASS: own local fixtures/evidence/audit rows and env file removed; child CLI stopped; no hosted changes.');
}
main().catch((error) => { console.error(`Local owner check failed: ${error instanceof assert.AssertionError ? error.message : 'Check local Docker migrations, Storage and Edge Runtime setup.'}`); process.exitCode = 1; });
