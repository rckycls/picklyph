const assert = require('node:assert/strict');
const { test } = require('node:test');
const config = require('../src/lib/config.ts');
const { readJsonBody, requireSameOrigin, vercelClientIp } = require('../src/lib/http.ts');
const { contentSecurityPolicy } = require('../src/lib/csp.ts');
const { createLookupHandler } = require('../src/lib/lookup-handler.ts');
const { LimiterUnavailable } = require('../src/lib/limits.ts');

const base = {
  PICKLY_ENV: 'production', PRELAUNCH_ORIGIN: 'https://register.pickly.example', PRELAUNCH_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  PRELAUNCH_SUPABASE_SECRET_KEY: 'sb_secret_unit_fixture_not_a_key', UPSTASH_REDIS_REST_URL: 'https://unit-db.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'unit-token', RATE_LIMIT_KEY_SECRET: 'r'.repeat(32), TURNSTILE_SECRET_KEY: '0x4AAAAAAunitsecret',
  TURNSTILE_SITE_KEY: '0x4AAAAAAunitsite', GOOGLE_MAPS_BROWSER_API_KEY: 'AIzaUnitBrowserKey000', GOOGLE_MAPS_SERVER_API_KEY: 'AIzaUnitServerKey0000',
  PRELAUNCH_CODE_SECRET: 'c'.repeat(32), EMAIL_API_KEY: 're_unit', EMAIL_FROM: 'pickly <hello@pickly.example>', PRELAUNCH_CONTACT_EMAIL: 'Hello@Pickly.example',
};
const fails = (read, patch) => assert.throws(() => read({ ...base, ...patch }), { name: 'WebConfigurationError' }, JSON.stringify(patch));

test('configuration: production needs https, real Upstash and real Turnstile keys; local may use loopback stand-ins', () => {
  assert.equal(config.readOrigin(base), 'https://register.pickly.example');
  assert.deepEqual(config.readLimiterConfig(base), { environment: 'production', url: 'https://unit-db.upstash.io', token: 'unit-token', salt: 'r'.repeat(32) });
  assert.equal(config.readTurnstileConfig(base).hostname, 'register.pickly.example');
  assert.equal(config.readEmailConfig(base).apiUrl, 'https://api.resend.com/emails');
  assert.equal(config.readEmailConfig(base).replyTo, 'hello@pickly.example');
  assert.deepEqual(config.readPageConfig(base), { mapsBrowserKey: base.GOOGLE_MAPS_BROWSER_API_KEY, turnstileSiteKey: base.TURNSTILE_SITE_KEY, contactEmail: 'hello@pickly.example' });
  fails(config.readOrigin, { PRELAUNCH_ORIGIN: 'http://127.0.0.1:3300' });
  fails(config.readOrigin, { PRELAUNCH_ORIGIN: 'https://register.pickly.example/register' });
  fails(config.readOrigin, { PICKLY_ENV: 'prod' });
  fails(config.readLimiterConfig, { UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079' });
  fails(config.readLimiterConfig, { UPSTASH_REDIS_REST_URL: 'https://redis.example.com' });
  fails(config.readLimiterConfig, { RATE_LIMIT_KEY_SECRET: 'short' });
  fails(config.readTurnstileConfig, { TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' });
  fails(config.readTurnstileConfig, { TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA' });
  fails(config.readSupabaseConfig, { PRELAUNCH_SUPABASE_SECRET_KEY: 'sb_publishable_unit' });
  fails(config.readSupabaseConfig, { PRELAUNCH_SUPABASE_URL: 'http://127.0.0.1:54321' });
  fails(config.readEmailConfig, { EMAIL_API_URL: 'http://127.0.0.1:9000/emails' });
  fails(config.readEmailConfig, { EMAIL_FROM: 'pickly <hello@pickly.example>\r\nBcc: x@y.z' });
  fails(config.readCodeSecret, { PRELAUNCH_CODE_SECRET: 'short' });
  fails(config.readPageConfig, { GOOGLE_MAPS_BROWSER_API_KEY: 'REPLACE_WITH_BROWSER_KEY' });
  fails(config.readPageConfig, { TURNSTILE_SITE_KEY: '<script>' });
  const local = { ...base, PICKLY_ENV: 'local', PRELAUNCH_ORIGIN: 'http://127.0.0.1:3300', PRELAUNCH_SUPABASE_URL: 'http://127.0.0.1:54321',
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', EMAIL_API_URL: 'http://127.0.0.1:9000/emails' };
  assert.equal(config.readLimiterConfig(local).url, 'http://127.0.0.1:8079');
  assert.equal(config.readTurnstileConfig(local).secret, '1x0000000000000000000000000000000AA');
  assert.equal(config.readEmailConfig(local).apiUrl, 'http://127.0.0.1:9000/emails');
  assert.equal(config.readSupabaseConfig(local).url, 'http://127.0.0.1:54321');
  assert.equal(config.readOrigin({ ...local, PRELAUNCH_ORIGIN: 'http://192.168.1.20:3200' }), 'http://192.168.1.20:3200', 'a phone on the LAN can try a local run');
  fails(config.readOrigin, { PICKLY_ENV: 'staging', PRELAUNCH_ORIGIN: 'http://192.168.1.20:3200' });
  const staging = { ...local, PICKLY_ENV: 'staging' };
  fails(() => config.readLimiterConfig(staging), {});
  fails(() => config.readEmailConfig(staging), {});
  assert.equal(config.readTrustVercelIp({ VERCEL: '1' }), true);
  assert.equal(config.readTrustVercelIp({}), false);
});

test('requests: same Origin, POST only and bounded JSON', async () => {
  const origin = 'https://register.pickly.example';
  assert.doesNotThrow(() => requireSameOrigin(new Request(origin, { method: 'POST', headers: { origin } }), origin));
  for (const supplied of [null, 'null', 'https://attacker.example', 'https://register.pickly.example.attacker.example', 'http://register.pickly.example']) {
    const request = new Request(origin, { method: 'POST', headers: { ...(supplied ? { origin: supplied } : {}), host: 'register.pickly.example', 'x-forwarded-host': 'register.pickly.example' } });
    assert.throws(() => requireSameOrigin(request, origin), (error) => error.status === 403);
  }
  assert.throws(() => requireSameOrigin(new Request(origin, { headers: { origin } }), origin), (error) => error.status === 405);
  const post = (body, type = 'application/json') => new Request(origin, { method: 'POST', headers: { 'Content-Type': type }, body });
  assert.deepEqual(await readJsonBody(post('{"a":1}'), 100), { a: 1 });
  assert.deepEqual(await readJsonBody(post('[1]', 'application/json; charset=utf-8'), 100), [1]);
  await assert.rejects(readJsonBody(post('{}', 'text/plain'), 100), (error) => error.status === 415);
  await assert.rejects(readJsonBody(post(`{"a":"${'x'.repeat(200)}"}`), 100), (error) => error.status === 413);
  await assert.rejects(readJsonBody(post('{'), 100), (error) => error.status === 400);
  await assert.rejects(readJsonBody(post(Uint8Array.from([0x7b, 0xff, 0x7d])), 100), (error) => error.status === 400);
});

test('client IP: only one canonical address from Vercel’s own header', () => {
  const ip = (value) => vercelClientIp(new Headers(value === undefined ? {} : { 'x-vercel-forwarded-for': value }));
  assert.equal(ip('203.0.113.9'), '203.0.113.9');
  assert.equal(ip('2001:DB8::1'), '2001:db8::1');
  for (const bad of [undefined, '', '203.0.113.9, 10.0.0.1', '203.0.113.256', '01.2.3.4', 'example.com', '[::1]', 'fe80::1%eth0', 'x'.repeat(46)]) assert.equal(ip(bad), null, String(bad));
  // A caller's own forwarding headers are never read.
  assert.equal(vercelClientIp(new Headers({ 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.1', 'cf-connecting-ip': '198.51.100.1' })), null);
});

test('CSP: only our origin, Google Maps and Turnstile; nonce-only inline scripts; no framing', () => {
  const policy = contentSecurityPolicy('bm9uY2U=', true);
  const directives = Object.fromEntries(policy.split('; ').map((part) => { const [name, ...values] = part.split(' '); return [name, values]; }));
  const allowed = new Set(["'self'", "'nonce-bm9uY2U='", "'unsafe-eval'", "'unsafe-inline'", "'none'", 'data:', 'blob:', 'https://*.googleapis.com', 'https://*.gstatic.com',
    'https://*.google.com', 'https://*.googleusercontent.com', 'https://*.ggpht.com', 'https://challenges.cloudflare.com', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']);
  for (const [name, values] of Object.entries(directives)) for (const source of values) assert.ok(allowed.has(source), `${name} ${source}`);
  assert.ok(directives['script-src'].includes("'nonce-bm9uY2U='"));
  assert.ok(!directives['script-src'].includes("'unsafe-inline'") && !directives['script-src'].includes("'strict-dynamic'"));
  assert.ok(directives['frame-src'].includes('https://challenges.cloudflare.com') && directives['script-src'].includes('https://challenges.cloudflare.com'));
  assert.deepEqual([directives['frame-ancestors'], directives['object-src'], directives['base-uri'], directives['default-src']], [["'none'"], ["'none'"], ["'none'"], ["'self'"]]);
  assert.ok('upgrade-insecure-requests' in directives);
  assert.ok(!contentSecurityPolicy('n', false).includes('upgrade-insecure-requests'), 'a local http run is not upgraded');
  assert.ok(!policy.includes('ws:') && contentSecurityPolicy('n', false, true).includes(' ws:'), 'only the dev server allows its hot-reload socket');
});

test('address lookup: same Origin, bounded query, IP limit that fails closed, and Geocoding errors as 503', async () => {
  const origin = 'https://register.pickly.example';
  const make = (overrides = {}) => {
    const calls = { limits: [], geocode: [] };
    const handle = createLookupHandler({ origin: () => origin, clientIp: () => null,
      limit: async (...args) => { calls.limits.push(args); return { allowed: true }; },
      geocode: async (query) => { calls.geocode.push(query); return [{ label: 'Makati, Metro Manila', address_line: 'Makati', city: 'Makati', province: 'Metro Manila', latitude: 14.55, longitude: 121.02 }]; },
      ...overrides });
    return { calls, handle };
  };
  const post = (body, headers = {}) => new Request(`${origin}/api/address`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const ok = make();
  const answer = await ok.handle(post({ query: '  Makati  City ' }));
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).candidates.length, 1);
  assert.deepEqual(ok.calls.geocode, ['Makati City']);
  assert.deepEqual(ok.calls.limits, [['prelaunch-lookup', 'ip', 'shared']]);
  for (const [request, status] of [[post({ query: 'Makati' }, { Origin: 'https://attacker.example' }), 403], [post({ query: 'ab' }), 400],
    [post({ query: 'x'.repeat(1100) }), 413], [post({ query: 'Makati', extra: 1 }), 400]]) {
    const { calls, handle } = make();
    assert.equal((await handle(request)).status, status);
    assert.equal(calls.geocode.length, 0);
  }
  const limited = make({ limit: async () => ({ allowed: false, retryAfter: 30 }) });
  const slow = await limited.handle(post({ query: 'Makati' }));
  assert.deepEqual([slow.status, slow.headers.get('retry-after'), limited.calls.geocode.length], [429, '30', 0]);
  const outage = make({ limit: async () => { throw new LimiterUnavailable(); } });
  assert.equal((await outage.handle(post({ query: 'Makati' }))).status, 503);
  assert.equal(outage.calls.geocode.length, 0);
  const broken = make({ geocode: async () => { throw new Error('Geocoding unavailable'); } });
  assert.equal((await broken.handle(post({ query: 'Makati' }))).status, 503);
  const unconfigured = make({ origin: () => { throw new Error('missing'); } });
  assert.equal((await unconfigured.handle(post({ query: 'Makati' }))).status, 503);
});
