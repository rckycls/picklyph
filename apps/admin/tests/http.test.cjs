const assert = require('node:assert/strict');
const { test } = require('node:test');
const { requireSameOrigin, readJsonBody, readEmail } = require('../src/lib/http.ts');
const { readAdminConfig, readDirectoryConfig } = require('../src/lib/config.ts');

test('trusted configured origin prevents cross-site requests and header-based host spoofing', () => {
  const origin = 'https://console.example.invalid';
  assert.doesNotThrow(() => requireSameOrigin(new Request(origin, { headers: { origin } }), origin));
  for (const supplied of [null, 'null', 'https://attacker.example.invalid', 'https://console.example.invalid.attacker.invalid']) {
    const request = new Request(origin, { headers: { ...(supplied ? { origin: supplied } : {}), host: 'attacker.invalid', 'x-forwarded-host': 'console.example.invalid' } });
    assert.throws(() => requireSameOrigin(request, origin), (error) => error.status === 403);
  }
});

test('bounded JSON input rejects oversized, malformed and non-object requests', async () => {
  const request = (body, type = 'application/json') => new Request('https://example.invalid', { method: 'POST', headers: { 'Content-Type': type }, body });
  assert.deepEqual(await readJsonBody(request('{"email":"user@example.invalid"}')), { email: 'user@example.invalid' });
  for (const body of ['null', '[]', '"text"', '{']) await assert.rejects(readJsonBody(request(body)), (error) => error.status === 400);
  await assert.rejects(readJsonBody(request('{}', 'text/plain')), (error) => error.status === 415);
  await assert.rejects(readJsonBody(request(JSON.stringify({ value: 'x'.repeat(4096) }))), (error) => error.status === 413);
  assert.equal(readEmail({ email: ' Person@Example.Invalid ' }), 'person@example.invalid');
  assert.throws(() => readEmail({ email: 'invalid' }), (error) => error.status === 400);
});

test('configuration excludes infrastructure keys and insecure remote endpoints', () => {
  const env = { ADMIN_SUPABASE_URL: 'https://project.supabase.co', ADMIN_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_fixture', ADMIN_ORIGIN: 'https://console.example.invalid' };
  assert.equal(readAdminConfig(env).origin, env.ADMIN_ORIGIN);
  for (const patch of [
    { ADMIN_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_unit_fixture' }, { ADMIN_SUPABASE_URL: 'http://remote.invalid' },
    { ADMIN_ORIGIN: 'https://console.example.invalid/path' }, { ADMIN_ORIGIN: '' }, { ADMIN_SUPABASE_URL: 'https://user:pass@project.supabase.co' },
  ]) assert.throws(() => readAdminConfig({ ...env, ...patch }), /configuration is unavailable/);
});

test('directory configuration requires an infrastructure key and bounded import bodies', async () => {
  const env = { ADMIN_SUPABASE_URL: 'https://project.supabase.co', ADMIN_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_fixture', ADMIN_ORIGIN: 'https://console.example.invalid' };
  assert.equal(readDirectoryConfig({ ...env, ADMIN_SUPABASE_SECRET_KEY: 'sb_secret_unit_fixture' }).key, 'sb_secret_unit_fixture');
  for (const key of [undefined, '', 'REPLACE_WITH_SECRET_KEY', 'sb_publishable_unit_fixture']) assert.throws(() => readDirectoryConfig({ ...env, ADMIN_SUPABASE_SECRET_KEY: key }), /configuration is unavailable/);
  const request = () => new Request(env.ADMIN_ORIGIN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(5000) }) });
  assert.equal((await readJsonBody(request(), 32 * 1024)).data.length, 5000);
  await assert.rejects(readJsonBody(request()), e => e.status === 413);
});
