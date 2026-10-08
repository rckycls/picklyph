// Rollback-only SQL + own local API fixtures for personal details and profile photos.
// Never reads the mobile/hosted environment.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

// Smallest valid JPEG/PNG headers are enough: Storage checks the declared type, not pixels.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

async function main() {
  const desktopDocker = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs/DockerDesktop/resources/bin/docker.exe') : '';
  const docker = desktopDocker && fs.existsSync(desktopDocker) ? desktopDocker : 'docker';
  const run = (args, input) => execFileSync(docker, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
  const context = run(['context', 'show']).trim();
  const host = process.env.DOCKER_HOST || run(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']).trim();
  assert.ok(host.startsWith('npipe://') || host.startsWith('unix://'), 'Only a local Docker engine is supported.');
  const container = 'supabase_db_picklyph';
  assert.equal(run(['inspect', container, '--format', '{{index .Config.Labels "com.supabase.cli.project"}}']).trim(), 'picklyph',
    'Expected this project’s local Supabase database.');
  run(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-o', '/dev/null'],
    fs.readFileSync(path.join(__dirname, 'profile.sql'), 'utf8'));
  console.log('PASS: Docker PostgreSQL profile suite (self-only details, constraints, avatar folder policies); rolled back.');

  const cli = path.resolve('node_modules/@supabase/cli-windows-x64/bin/supabase.exe');
  const config = JSON.parse(execFileSync(cli, ['status', '-o', 'json'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }));
  const api = new URL(config.API_URL);
  assert.ok(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname) && api.port === '54321', 'Expected this project’s loopback API.');
  const options = { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10000) }) } };
  const server = createClient(api.href, config.SERVICE_ROLE_KEY, options);
  const check = (response, message) => { assert.ok(!response.error, message); return response.data; };
  const users = [];
  const clients = [];
  const objects = [];
  try {
    for (let i = 0; i < 2; i++) {
      const email = `profile-${randomUUID()}@example.test`;
      const password = `Local-${randomUUID()}!`;
      const created = check(await server.auth.admin.createUser({ email, password, email_confirm: true }), 'Fixture signup.');
      users.push(created.user.id);
      const client = createClient(api.href, config.ANON_KEY, options);
      clients.push(client);
      check(await client.auth.signInWithPassword({ email, password }), 'Fixture sign-in.');
    }
    const [me, other] = clients;
    const [myId, otherId] = users;

    // Personal details: own row only, through the same calls the app makes.
    const saved = check(await me.from('profiles').update({ first_name: 'Rocky', last_name: 'Celis', phone: '+639171234567' })
      .eq('id', myId).select('*').single(), 'Own details save.');
    assert.deepEqual([saved.first_name, saved.last_name, saved.phone], ['Rocky', 'Celis', '+639171234567']);
    assert.ok((await me.from('profiles').update({ phone: '0917' }).eq('id', myId).select('*').single()).error, 'Invalid phone refused.');
    const foreign = await me.from('profiles').update({ first_name: 'Mallory' }).eq('id', otherId).select('*');
    assert.ok(!foreign.error && foreign.data.length === 0, 'Another account’s details are untouched.');
    assert.equal(check(await me.from('profiles').select('id'), 'Own read.').length, 1, 'Only the own profile is readable.');

    // Photos: upload under the own folder, sign a link, refuse others' folders, remove.
    const mine = `${myId}/${randomUUID()}.jpg`;
    check(await me.storage.from('avatars').upload(mine, JPEG, { contentType: 'image/jpeg', upsert: false }), 'Own photo upload.');
    objects.push(mine);
    check(await me.from('profiles').update({ avatar_path: mine }).eq('id', myId).select('*').single(), 'Profile points at the photo.');
    const link = check(await me.storage.from('avatars').createSignedUrl(mine, 60), 'Own signed link.');
    const fetched = await fetch(link.signedUrl, { signal: AbortSignal.timeout(10000) });
    assert.ok(fetched.ok && Buffer.from(await fetched.arrayBuffer()).equals(JPEG), 'Signed link serves the photo.');
    assert.ok((await other.storage.from('avatars').createSignedUrl(mine, 60)).error, 'Others cannot sign my photo.');
    assert.ok((await other.storage.from('avatars').download(mine)).error, 'Others cannot download my photo.');
    const otherList = await other.storage.from('avatars').list(myId);
    assert.ok(otherList.error || otherList.data.length === 0, 'Others cannot list my folder.');
    assert.ok((await createClient(api.href, config.ANON_KEY, options).storage.from('avatars').download(mine)).error, 'Guests cannot read photos.');
    const intruding = `${myId}/${randomUUID()}.jpg`;
    assert.ok((await other.storage.from('avatars').upload(intruding, JPEG, { contentType: 'image/jpeg' })).error, 'Nobody uploads into my folder.');
    assert.ok((await me.storage.from('avatars').upload(`${myId}/${randomUUID()}.gif`, JPEG, { contentType: 'image/gif' })).error, 'Only JPEG/PNG names and types.');
    assert.ok((await me.from('profiles').update({ avatar_path: `${otherId}/${randomUUID()}.jpg` }).eq('id', myId).select('*').single()).error,
      'A profile cannot point at another account’s folder.');
    await other.storage.from('avatars').remove([mine]);
    assert.ok(!(await me.storage.from('avatars').download(mine)).error, 'Others cannot delete my photo.');
    check(await me.storage.from('avatars').remove([mine]), 'Own photo removal.');
    assert.ok((await me.storage.from('avatars').download(mine)).error, 'Removed photo is gone.');
    objects.length = 0;
    console.log('PASS: real Auth/PostgREST/Storage: own details only, invalid phone refused, private photo upload/sign/remove, cross-account and guest access denied.');
  } finally {
    let clean = true;
    if (objects.length) { try { await server.storage.from('avatars').remove(objects); } catch { clean = false; } }
    for (const id of users) {
      try {
        const leftovers = check(await server.storage.from('avatars').list(id), 'List own fixture photos.') ?? [];
        if (leftovers.length) await server.storage.from('avatars').remove(leftovers.map((file) => `${id}/${file.name}`));
        if ((await server.auth.admin.deleteUser(id)).error) clean = false;
      } catch { clean = false; }
    }
    for (const client of clients) { try { await client.auth.signOut({ scope: 'local' }); } catch { /* local only */ } }
    assert.ok(clean, 'Own local fixtures must be removed.');
  }
  console.log('PASS: own local accounts and photos removed; no hosted changes.');
}
main().catch((error) => {
  console.error(`Local profile check failed: ${error instanceof assert.AssertionError ? error.message : 'Check the local Supabase stack and migrations.'}`);
  process.exitCode = 1;
});
