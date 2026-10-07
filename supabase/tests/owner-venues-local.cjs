// Local Docker/Auth/PostgREST/Storage + actual Edge Runtime. No hosted/mobile env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { createClient } = require('@supabase/supabase-js');
const load = require('./load-ts.cjs');
const { addVenuePhoto, listOwnedVenues, loadOwnedVenue, removeVenuePhoto, saveOwnedVenue } = require('../../src/features/owner/venueClient.ts');
const { loadVenueDetail } = require('../../src/features/discovery/venueDetail.ts');

async function main() {
  const dockerPath = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
  const docker = fs.existsSync(dockerPath) ? dockerPath : 'docker';
  const run = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });
  const context = run(['context', 'show']).trim();
  const host = process.env.DOCKER_HOST || run(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://') || host.startsWith('unix://'), 'Requires a local Docker engine');
  assert.equal(run(['inspect', 'supabase_db_picklyph', '--format', '{{index .Config.Labels "com.supabase.cli.project"}}']).trim(), 'picklyph');
  const psql = (sql) => run(['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], sql).trim();
  run(['exec', '-i', 'supabase_db_picklyph', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-o', '/dev/null'],
    fs.readFileSync(path.join(__dirname, 'owner-venues.sql'), 'utf8'));
  console.log('PASS: Docker owner SQL permissions, versions, limits, publication isolation and transactional audit; fixtures rolled back.');
  const cli = path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }));
  const api = new URL(config.API_URL);
  assert.ok(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname) && api.port === '54321', 'Requires loopback Supabase');
  const options = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) }) } };
  const service = createClient(api.href, config.SERVICE_ROLE_KEY, options);
  const anonymous = createClient(api.href, config.ANON_KEY, options);
  const owner = createClient(api.href, config.ANON_KEY, options);
  const other = createClient(api.href, config.ANON_KEY, options);
  const check = (result, message) => { assert.ok(!result.error, message); return result.data; };
  const venueId = randomUUID(); const users = []; let venueCreated = false; let child;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pickly-venues-'));
  const bucket = service.storage.from('venue-photos');
  const objects = async () => check(await bucket.list(venueId), 'List own photo objects');
  const root = path.resolve(__dirname, '../..');
  const handlerModule = load(path.join(root, 'supabase/functions/owner-venues/handler.ts'), {}, { AbortSignal, FormData, Blob, TextDecoder, DataView });
  const { createSupabaseVenueDeps } = load(path.join(root, 'supabase/functions/owner-venues/deps.ts'), { './handler.ts': handlerModule });
  try {
    check(await service.from('venues').insert({ id: venueId, name: 'Local Owner Editor', address_line: '1 Fixture St', city: 'Fixture City', province: 'Fixture',
      latitude: 14.6, longitude: 121, publication_status: 'approved', claim_status: 'verified' }), 'Fixture venue');
    venueCreated = true;
    check(await service.from('courts').insert({ venue_id: venueId, name: 'Court 1', surface: 'hard' }), 'Fixture court');
    const sessions = [];
    for (const client of [owner, other]) {
      const credentials = { email: `venue-${randomUUID()}@example.test`, password: `Local-${randomUUID()}!` };
      users.push(check(await service.auth.admin.createUser({ ...credentials, email_confirm: true }), 'Fixture user').user.id);
      sessions.push(check(await client.auth.signInWithPassword(credentials), 'Fixture login').session);
    }
    const [ownerId] = users;
    psql(`insert into private.venue_owners(user_id,venue_id) values ('${ownerId}','${venueId}');`);
    const verifier = () => createClient(api.href, config.ANON_KEY, options);
    const server = () => createClient(api.href, config.SERVICE_ROLE_KEY, options);
    const handler = handlerModule.createVenueHandler({ ...createSupabaseVenueDeps(verifier, server),
      limit: async () => ({ allowed: true, status: 200, state: 'enforced', headers: {} }), newId: () => randomUUID() });
    const sharp = require('sharp');
    const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#1E3F7C' } }).jpeg()
      .withExif({ IFD0: { Artist: 'Private Owner Name', Make: 'Private Camera' } }).toBuffer();
    const picked = { uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg', size: jpeg.length };
    const transport = (session) => ({ endpoint: 'https://venue.local/functions/v1/owner-venues', apiKey: config.ANON_KEY,
      accessToken: async () => session.access_token, fetch: (url, init) => handler(new Request(url, init)), photoPart: () => new Blob([jpeg]) });
    const live = transport(sessions[0]); const stranger = transport(sessions[1]);
    const outcome = (value) => { assert.ok(value.ok, value.failure?.reason || value.failure?.kind); return value.value; };
    assert.equal(outcome(await listOwnedVenues(live))[0].id, venueId);
    assert.equal(outcome(await listOwnedVenues(stranger)).length, 0);
    assert.equal((await loadOwnedVenue(stranger, venueId)).failure.reason, 'not_owner');
    const initial = outcome(await loadOwnedVenue(live, venueId));
    const save = { kind: 'save', venue_id: venueId, expected_updated_at: initial.updated_at,
      venue: { name: 'Owner Edited', address_line: initial.address_line, city: initial.city, province: initial.province },
      courts: initial.courts.map(({ id, name, surface, is_indoor, is_covered, status }) => ({ id, name, surface, is_indoor, is_covered, status })) };
    assert.equal((await saveOwnedVenue(stranger, save)).failure.reason, 'not_owner');
    const race = await Promise.all([saveOwnedVenue(live, save), saveOwnedVenue(live, { ...save, venue: { ...save.venue, name: 'Other Edit' } })]);
    assert.equal(race.filter((r) => r.ok).length, 1);
    assert.equal(race.find((r) => !r.ok).failure.reason, 'version_conflict');
    const saved = race.find((r) => r.ok).value;
    assert.equal(saved.latitude, initial.latitude); assert.equal(saved.publication_status, 'approved'); assert.equal(saved.claim_status, 'verified');
    assert.equal(saved.courts[0].id, initial.courts[0].id);
    assert.equal(psql(`select count(*) from private.directory_audit_events where target_venue_id='${venueId}' and action='owner.update' and actor_user_id='${ownerId}'`), '1');
    const requests = Array.from({ length: 7 }, () => ({ venue_id: venueId, request_id: randomUUID() }));
    for (const request of requests.slice(0, 5)) outcome(await addVenuePhoto(live, request, picked));
    const photosRace = await Promise.all(requests.slice(5).map((request) => addVenuePhoto(live, request, picked)));
    assert.equal(photosRace.filter((r) => r.ok).length, 1);
    assert.equal(photosRace.find((r) => !r.ok).failure.reason, 'too_many_photos');
    const finalRequest = requests[5 + photosRace.findIndex((r) => r.ok)];
    assert.equal(outcome(await addVenuePhoto(live, finalRequest, picked)).photos.length, 6, 'retry at full gallery');
    assert.equal((await objects()).length, 6, 'rejected and duplicate uploads cleaned up');
    assert.equal(psql(`select count(*) from private.directory_audit_events where target_venue_id='${venueId}' and action='owner.photo_add'`), '6');
    const detail = await loadVenueDetail(anonymous, venueId);
    assert.equal(detail.photos.length, 6, 'guest public detail includes photos');
    assert.ok(!JSON.stringify(detail).includes(ownerId) && !JSON.stringify(detail).includes('request_id'), 'public data has no uploader/request IDs');
    const photo = detail.photos[0]; const publicUrl = bucket.getPublicUrl(photo.storage_path).data.publicUrl;
    const response = await fetch(publicUrl);
    assert.equal(response.status, 200, 'guest photo bytes');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 800); assert.equal(metadata.height, 600);
    assert.equal(metadata.exif, undefined, 'identifying EXIF removed before Storage');
    for (const [client, label] of [[owner, 'owner'], [other, 'other'], [anonymous, 'guest']]) {
      const storage = client.storage.from('venue-photos');
      assert.ok((await storage.upload(`${venueId}/${randomUUID()}.jpg`, new Blob([jpeg]), { contentType: 'image/jpeg' })).error, `${label}: direct upload denied`);
      assert.ok((await storage.update(photo.storage_path, new Blob([jpeg]), { contentType: 'image/jpeg' })).error, `${label}: direct replacement denied`);
      const listed = await storage.list(venueId);
      assert.ok(listed.error || listed.data.length === 0, `${label}: object listing denied`);
      await storage.remove([photo.storage_path]);
      assert.equal((await fetch(publicUrl)).status, 200, `${label}: direct removal did not delete bytes`);
      assert.equal((await client.rpc('owner_venue_save', { actor_user_id: ownerId, target_venue_id: venueId,
        expected_updated_at: saved.updated_at, venue_input: save.venue, court_inputs: save.courts })).error?.code, '42501', `${label}: RPC bypass denied`);
      assert.ok((await client.from('venue_photos').delete().eq('id', photo.id)).error, `${label}: photo-row mutation denied`);
    }
    const removed = outcome(await removeVenuePhoto(live, { venue_id: venueId, photo_id: photo.id }));
    assert.equal(removed.photos.length, 5); assert.equal((await objects()).length, 5);
    assert.equal(outcome(await removeVenuePhoto(live, { venue_id: venueId, photo_id: photo.id })).photos.length, 5);
    assert.equal(psql(`select count(*) from private.directory_audit_events where target_venue_id='${venueId}' and action='owner.photo_remove'`), '1');
    check(await service.from('venues').update({ publication_status: 'suspended' }).eq('id', venueId), 'Suspend own fixture');
    assert.equal(await loadVenueDetail(anonymous, venueId), null);
    assert.equal(check(await anonymous.from('venue_photos').select('id').eq('venue_id', venueId), 'Suspended photo rows').length, 0);
    assert.equal((await saveOwnedVenue(live, { ...save, expected_updated_at: saved.updated_at })).failure.reason, 'venue_unavailable');
    assert.equal((await addVenuePhoto(live, { venue_id: venueId, request_id: randomUUID() }, picked)).failure.reason, 'venue_unavailable');
    check(await service.from('venues').update({ publication_status: 'approved' }).eq('id', venueId), 'Restore own fixture');
    psql(`delete from private.venue_owners where user_id='${ownerId}' and venue_id='${venueId}';`);
    assert.equal((await loadOwnedVenue(live, venueId)).failure.reason, 'not_owner');
    assert.equal((await saveOwnedVenue(live, save)).failure.reason, 'not_owner');
    assert.equal((await addVenuePhoto(live, { venue_id: venueId, request_id: randomUUID() }, picked)).failure.reason, 'not_owner');
    assert.equal((await removeVenuePhoto(live, { venue_id: venueId, photo_id: removed.photos[0].id })).failure.reason, 'not_owner');
    assert.equal((await objects()).length, 5, 'revoked owner has no storage side effect');
    psql(`insert into private.venue_owners(user_id,venue_id) values ('${ownerId}','${venueId}');`);
    console.log('PASS: real Auth + mobile client + RPC/Storage: save race, photo-cap race, full-gallery retry, metadata stripping, public detail, direct-write denial, suspension/revocation and actor audit.');

    // Actual served Edge function with missing Redis: bounded reads continue; writes fail closed.
    const envPath = path.join(temp, 'function.env');
    fs.writeFileSync(envPath, ['DISCOVERY_SUPABASE_URL=http://kong:8000', `DISCOVERY_SUPABASE_PUBLISHABLE_KEY=${config.ANON_KEY}`,
      `DISCOVERY_SUPABASE_SECRET_KEY=${config.SERVICE_ROLE_KEY}`, 'PICKLY_ENV=local'].join('\n'), { mode: 0o600 });
    child = spawn(cli, ['functions', 'serve', 'owner-venues', '--env-file', envPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let launchError = false; child.on('error', () => { launchError = true; });
    const endpoint = new URL('functions/v1/owner-venues', api).href;
    const invoke = (token, init = {}) => fetch(endpoint, { ...init, headers: { apikey: config.ANON_KEY,
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers }, signal: AbortSignal.timeout(8000) });
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      assert.ok(!launchError && child.exitCode === null, 'Own Edge server remains running');
      try { if ((await invoke(null)).status === 401) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'Local endpoint ready');
    assert.equal((await invoke('forged')).status, 401);
    const forged = `${sessions[0].access_token.split('.')[0]}.${Buffer.from(JSON.stringify({ sub: ownerId, role: 'authenticated', exp: 9999999999 })).toString('base64url')}.forged`;
    assert.equal((await invoke(forged)).status, 401);
    const read = await invoke(sessions[0].access_token);
    assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'private, no-store');
    assert.equal((await read.json()).venues[0].id, venueId);
    const refused = await invoke(sessions[0].access_token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(save) });
    assert.equal(refused.status, 503); assert.equal(refused.headers.get('retry-after'), '5');
    const form = new FormData(); form.append('photo', JSON.stringify({ venue_id: venueId, request_id: randomUUID() })); form.append('file', new Blob([jpeg]), 'photo.jpg');
    assert.equal((await invoke(sessions[0].access_token, { method: 'POST', body: form })).status, 503);
    assert.equal((await objects()).length, 5);
    console.log('PASS: actual Edge Runtime verifies bearer tokens, returns private bounded reads and rejects edits/uploads before side effects when Redis is unavailable.');
  } finally {
    let clean = true;
    if (child && child.exitCode === null) child.kill();
    const steps = [async () => { const files = await objects(); if (files.length) check(await bucket.remove(files.map((file) => `${venueId}/${file.name}`)), 'Own photos cleanup'); }];
    if (venueCreated) steps.push(() => service.from('venues').delete().eq('id', venueId).then((r) => check(r, 'Own venue cleanup')));
    for (const userId of users) steps.push(() => service.auth.admin.deleteUser(userId).then((r) => check(r, 'Own user cleanup')));
    steps.push(() => psql(`delete from private.directory_audit_events where target_venue_id='${venueId}';`));
    steps.push(() => {
      assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert.match(path.basename(temp), /^pickly-venues-/);
      fs.rmSync(temp, { recursive: true, force: true });
    });
    for (const client of [service, anonymous, owner, other]) steps.push(() => client.auth.stopAutoRefresh());
    for (const step of steps) { try { await step(); } catch { clean = false; } }
    assert.ok(clean, 'Own local photos, fixtures, audit and temporary env removed');
    assert.equal(psql(`select (select count(*) from private.directory_audit_events where target_venue_id='${venueId}')
      +(select count(*) from public.venues where id='${venueId}')
      +(select count(*) from storage.objects where bucket_id='venue-photos' and split_part(name,'/',1)='${venueId}')`), '0');
  }
  console.log('PASS: own local fixtures/photos/audit/env removed; only own child stopped; no hosted changes.');
}
main().catch((error) => { console.error(`Local owner venue check failed: ${error instanceof assert.AssertionError ? error.message : 'Check local migrations, Storage and Edge Runtime setup.'}`); process.exitCode = 1; });
