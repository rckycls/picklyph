const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const load = require('./load-ts.cjs');
const root = path.resolve(__dirname, '../..');
const { readVenueSearch } = load(path.join(root, 'packages/domain/src/search.ts'));
const { createRateGuard, guestSource } = load(path.join(root, 'supabase/functions/_shared/rate-limit.ts'));
const { createSearchHandler } = load(path.join(root, 'supabase/functions/venue-search/handler.ts'));
const user = { kind: 'user', id: 'verified-auth-user' };
const guest = { kind: 'guest', id: 'unknown' };
const allowed = { allowed: true, status: 200, state: 'enforced', headers: { 'X-RateLimit-Remaining': '29' } };
const params = (query) => new URLSearchParams(query);

test('Upstash packages and server secret names remain outside mobile/admin source and npm dependency graphs', () => {
  const forbidden = /@upstash\/|UPSTASH_REDIS_REST_TOKEN|RATE_LIMIT_KEY_SECRET|DISCOVERY_SUPABASE_SECRET_KEY/;
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules','.next','.expo','dist'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) assert.ok(!forbidden.test(fs.readFileSync(file,'utf8')), `Server limiter leaked into ${path.relative(root,file)}`);
    }
  }
  scan(path.join(root,'src')); scan(path.join(root,'apps/admin/src'));
  for (const file of ['package.json','apps/admin/package.json','packages/domain/package.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
    for (const dependencies of [manifest.dependencies,manifest.devDependencies]) {
      assert.ok(Object.keys(dependencies??{}).every((name)=>!name.startsWith('@upstash/')));
    }
  }
});

test('search contract accepts bounds, exact city, literal names and intersecting filters; rejects unbounded/malformed input', () => {
  const query = readVenueSearch(params('south=4&west=116&north=22&east=127&city=%20Manila%20&name=50%25&indoor=false&covered=true&surface=hard&limit=50'));
  assert.equal(query.city, 'Manila'); assert.equal(query.name, '50%'); assert.equal(query.indoor, false); assert.equal(query.limit, 50);
  for (const invalid of ['', 'indoor=true', 'city=M', 'name=ab', 'city=Manila&limit=51', 'city=Manila&limit=0',
    'city=Manila&limit=1.5', 'city=Manila&limit=', 'city=Manila&indoor=1', 'city=Manila&surface=clay', 'city=Manila&after=x',
    'city=Manila&city=Cebu', 'city=Manila&actor=x', 'city=%00Manila', 'south=0&west=0&north=31&east=1',
    'south=0&west=170&north=1&east=-170', 'south=0&west=0&north=NaN&east=1', 'south=&west=0&north=1&east=1',
    'south=0&west=0&north=1e1&east=1', 'south=2&west=0&north=1&east=1', 'south=0&west=0&north=1',
    `city=${'x'.repeat(81)}`, `name=${'x'.repeat(121)}`]) assert.throws(() => readVenueSearch(params(invalid)), undefined, invalid);
});

test('guest IP trust: ignores XFF/caller headers by default, canonicalizes trusted IP and shares unknown bucket on malformed values', () => {
  assert.equal(guestSource(new Headers({ 'x-forwarded-for': 'spoofed, 1.2.3.4', 'cf-connecting-ip': '1.2.3.4' }), 'unknown'), 'unknown');
  assert.equal(guestSource(new Headers({ 'cf-connecting-ip': '1.2.3.4' }), 'cloudflare'), '1.2.3.4');
  assert.equal(guestSource(new Headers({ 'cf-connecting-ip': '2001:0db8:0:0:0:0:0:1' }), 'cloudflare'), '[2001:db8::1]');
  for (const bad of ['256.1.1.1', '01.2.3.4', '1.2.3.4,5.6.7.8', 'bad', '1.2.3.4:80', 'fe80::1%eth0', '2001:db8:::1']) {
    assert.equal(guestSource(new Headers({ 'cf-connecting-ip': bad }), 'cloudflare'), 'unknown');
  }
});

test('guard returns429 with safe retry/reset and separates verified principal/action identifiers', async () => {
  const calls = [];
  const guard = createRateGuard({ now: () => 1000, identifier: async (p) => `${p.kind}:${p.id}`,
    backend: async (...args) => { calls.push(args); return { success: false, limit: 30, remaining: 0, reset: 3500 }; } });
  const result = await guard('discovery', guest);
  assert.equal(result.status, 429); assert.equal(result.headers['Retry-After'], '3'); assert.equal(result.headers['X-RateLimit-Reset'], '4');
  await guard('hold-create', user);
  assert.equal(calls[0][2], 'guest:unknown'); assert.equal(calls[1][0], 'hold-create'); assert.equal(calls[1][2], 'user:verified-auth-user');
  await assert.rejects(guard('hold-create', guest)); await assert.rejects(guard('discovery', { kind: 'provider', id: 'signature' }));
});

test('Redis throws, SDK success-on-timeout, malformed reply and hanging operation follow locked per-action outage policies', async () => {
  for (const backend of [async () => { throw new Error('secret infrastructure URL/token'); },
    async () => ({ success: true, reason: 'timeout', limit: 10, remaining: 10, reset: 1000 }),
    async () => ({ success: true, limit: NaN, remaining: 2, reset: 1000 }),
    () => new Promise(() => {})]) {
    const guard = createRateGuard({ backend, identifier: async () => 'hash', timeoutMs: 10 });
    for (const action of ['hold-create', 'checkout-create', 'owner-submit', 'owner-edit']) {
      const result = await guard(action, user); assert.equal(result.status, 503); assert.equal(result.allowed, false); assert.equal(result.headers['Retry-After'], '5');
    }
    for (const action of ['discovery', 'cancel', 'owner-read']) { const result = await guard(action, user); assert.equal(result.allowed, true); assert.equal(result.state, 'degraded'); }
    assert.equal((await guard('provider-webhook', { kind: 'provider', id: 'verified-provider' })).state, 'bypassed');
  }
});

test('Upstash adapter uses HMAC keys, environment/action/principal namespaces, pinned caps and no analytics/cache/retries', async () => {
  const constructions = []; const identifiers = [];
  class Redis { constructor(options) { constructions.push(options); } }
  class Ratelimit {
    constructor(options) { constructions.push(options); }
    static slidingWindow(limit, duration) { return { limit, duration }; }
    async limit(identifier) { identifiers.push(identifier); return { success: true, limit: 30, remaining: 29, reset: Date.now()+60000 }; }
  }
  const { buildUpstashGuard } = load(path.join(root, 'supabase/functions/_shared/upstash.ts'), { '@upstash/redis': { Redis }, '@upstash/ratelimit': { Ratelimit } });
  const env = { PICKLY_ENV: 'staging', UPSTASH_REDIS_REST_URL: 'https://fixture.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'in-memory-test', RATE_LIMIT_KEY_SECRET: 'in-memory-fixture-hmac-salt-only-32' };
  const guard = buildUpstashGuard((key) => env[key]);
  assert.equal((await guard('discovery', guest)).state, 'enforced'); await guard('hold-create', user);
  const production = buildUpstashGuard((key) => key === 'PICKLY_ENV' ? 'production' : env[key]); await production('discovery', guest);
  assert.equal(constructions[0].retry, false);
  const limiters = constructions.filter((x) => x.prefix);
  assert.deepEqual(limiters.map((x) => x.prefix), ['pickly:staging:discovery:guest', 'pickly:staging:hold-create:user', 'pickly:production:discovery:guest']);
  assert.equal(limiters[0].limiter.limit, 30); assert.equal(limiters[1].limiter.limit, 10);
  for (const options of limiters) { assert.equal(options.timeout, 650); assert.equal(options.analytics, false); assert.equal(options.ephemeralCache, false); }
  assert.match(identifiers[0], /^[a-f0-9]{64}$/); assert.equal(identifiers[0], identifiers[2]); assert.notEqual(identifiers[0], identifiers[1]);
  for (const change of [{}, { ...env, PICKLY_ENV: 'development' }, { ...env, UPSTASH_REDIS_REST_URL: 'http://fixture.upstash.io' }, { ...env, RATE_LIMIT_KEY_SECRET: 'short' }]) {
    const missing = buildUpstashGuard((key) => change[key]); assert.equal((await missing('hold-create', user)).status, 503); assert.equal((await missing('discovery', guest)).state, 'degraded');
  }
});

test('endpoint gates requests before DB work, verifies bearer identities, emits429/retry and sanitizes outages', async () => {
  const queries = []; const principals = [];
  const deps = { verifyUser: async (token) => token === 'valid-user' ? 'server-verified-id' : null,
    guestSource: () => 'trusted-source', limit: async (principal) => { principals.push(principal); return allowed; },
    search: async (query) => { queries.push(query); return { venues: [], next_cursor: null }; } };
  const handler = createSearchHandler(deps);
  const request = (query='city=Manila', headers={}, method='GET') => new Request(`https://test.local/venue-search?${query}`, { method, headers });
  assert.equal((await handler(request('', {}, 'POST'))).status, 405);
  assert.equal((await handler(request('', {}, 'OPTIONS'))).status, 204);
  assert.equal((await handler(request('city=Manila&limit=51'))).status, 400);
  assert.equal((await handler(request('city=Manila', { authorization: 'Bearer forged' }))).status, 401);
  assert.equal((await handler(request('city=Manila', { authorization: 'bad' }))).status, 401); assert.equal(queries.length, 0);
  const response = await handler(request()); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(principals[0].kind, 'guest'); assert.equal(principals[0].id, 'trusted-source');
  await handler(request('city=Manila', { authorization: 'Bearer valid-user', 'x-user-id': 'forged' }));
  assert.equal(principals[1].id, 'server-verified-id');
  const block = createSearchHandler({ ...deps, limit: async () => ({ allowed: false, status: 429, state: 'enforced', headers: { 'Retry-After': '7' } }) });
  const before = queries.length; const blocked = await block(request()); assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '7'); assert.equal(queries.length, before);
  for (const failed of [createSearchHandler({ ...deps, search: async () => { throw new Error('private secret'); } }),
    createSearchHandler({ ...deps, verifyUser: async () => { throw new Error('private secret'); } })]) {
    const result = await failed(request('city=Manila', { authorization: 'Bearer valid-user' })); assert.equal(result.status, 503); assert.ok(!(await result.text()).includes('secret'));
  }
  let degraded = false;
  const fallback = createSearchHandler({ ...deps, limit: async () => ({ ...allowed, state: 'degraded', headers: {} }), degraded: () => { degraded = true; } });
  assert.equal((await fallback(request())).status, 200); assert.equal(degraded, true);
});

test('search RPC spatial/filter/keyset validation and server-only permission suite on real embedded PostgreSQL/PostGIS', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { postgis } = await import('@electric-sql/pglite-postgis');
  const db = new PGlite({ extensions: { postgis, pg_trgm: (await import('@electric-sql/pglite/contrib/pg_trgm')).pg_trgm } });
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);');
    for (const file of ['supabase/migrations/20261006030000_directory.sql', 'supabase/migrations/20261007090000_directory_search.sql', 'supabase/tests/search.sql']) {
      await db.exec(fs.readFileSync(path.join(root, file), 'utf8'));
    }
    assert.equal((await db.query('select count(*)::integer as n from public.venues')).rows[0].n, 0);
  } finally { await db.close(); }
});
