const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const load = require('./load-ts.cjs');
const root = path.resolve(__dirname, '../..');
const globals = { AbortSignal, FormData, Blob };
const { createOwnerHandler, CommandRejected } = load(path.join(root, 'supabase/functions/owner-submissions/handler.ts'), {}, globals);
const { parseGeocode, createGeocoder } = load(path.join(root, 'supabase/functions/owner-submissions/geocode.ts'), {}, globals);
const { createRateGuard } = load(path.join(root, 'supabase/functions/_shared/rate-limit.ts'));

const ACTOR = 'a1000000-0000-4000-8000-000000000001';
const VENUE = 'b1000000-0000-4000-8000-000000000001';
const REQUEST = 'c1000000-0000-4000-8000-000000000001';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
// Values created inside the loader's VM realm have different prototypes; compare plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const allowed = { allowed: true, status: 200, state: 'enforced', headers: { 'X-RateLimit-Remaining': '9' } };
const created = { outcome: 'created', submission: { id: 'd1000000-0000-4000-8000-000000000001', kind: 'claim', status: 'pending', venue_id: VENUE, name: 'Venue', city: 'Manila', created_at: '2026-10-07T00:00:00Z' }, duplicates: [] };
const claim = { kind: 'claim', request_id: REQUEST, venue_id: VENUE, note: null };

function harness(overrides = {}) {
  const calls = { limit: [], upload: [], remove: [], submit: [], nearby: [], geocode: [], warn: [] };
  const deps = {
    verifyUser: async (token) => (token === 'valid-user' ? ACTOR : null),
    limit: async (action, principal) => { calls.limit.push([action, principal]); return allowed; },
    geocode: async (address) => { calls.geocode.push(address); return [{ label: '12 Fixture St, Manila, Philippines', address_line: '12 Fixture St', city: 'Manila', province: 'Metro Manila', latitude: 14.6, longitude: 121 }]; },
    nearby: async (...args) => { calls.nearby.push(args); return []; },
    upload: async (...args) => { calls.upload.push(args); },
    remove: async (file) => { calls.remove.push(file); },
    submit: async (...args) => { calls.submit.push(args); return created; },
    newId: () => 'e1000000-0000-4000-8000-000000000001',
    warn: (event) => calls.warn.push(event),
    ...overrides,
  };
  return { calls, handler: createOwnerHandler(deps) };
}
const url = 'https://test.local/owner-submissions';
const get = (query, headers = { authorization: 'Bearer valid-user' }) => new Request(`${url}?${query}`, { headers });
function post(submission = claim, evidence = JPEG, extra = {}, headers = { authorization: 'Bearer valid-user' }) {
  const form = new FormData();
  form.append('submission', typeof submission === 'string' ? submission : JSON.stringify(submission));
  if (evidence) form.append('evidence', new Blob([evidence], { type: 'image/png' }), 'client-name.png');
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return new Request(url, { method: 'POST', body: form, headers });
}

test('mobile/admin source never references the server Maps key, evidence bucket or owner command RPCs', () => {
  const forbidden = /GOOGLE_MAPS_SERVER_API_KEY|owner-evidence|owner_submit_(claim|venue)|owner_duplicate_candidates/;
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.next', '.expo', 'dist', '__tests__'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) assert.ok(!forbidden.test(fs.readFileSync(file, 'utf8')), `Server-only owner detail in ${path.relative(root, file)}`);
    }
  }
  scan(path.join(root, 'src')); scan(path.join(root, 'apps/admin/src'));
});

test('every owner command requires a verified bearer; identity never comes from the request', async () => {
  const { handler, calls } = harness();
  assert.equal((await handler(new Request(url, { method: 'PUT' }))).status, 405);
  assert.equal((await handler(new Request(url, { method: 'OPTIONS' }))).status, 405, 'native-only: no browser preflight');
  const anonymous = await handler(get('address=Manila', {}));
  assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).error, 'sign_in_required');
  assert.equal((await handler(get('address=Manila', { authorization: 'Bearer forged' }))).status, 401);
  assert.equal((await handler(get('address=Manila', { authorization: 'Basic x' }))).status, 401);
  assert.equal((await handler(post(claim, JPEG, {}, { authorization: 'Bearer forged' }))).status, 401);
  assert.equal(calls.limit.length + calls.upload.length + calls.submit.length, 0, 'nothing runs before identity');
  const down = harness({ verifyUser: async () => { throw new Error('auth host secret'); } });
  const unavailable = await down.handler(get('address=Manila'));
  assert.equal(unavailable.status, 503); assert.ok(!(await unavailable.text()).includes('secret'));
  await handler(post({ ...claim }, JPEG, {}, { authorization: 'Bearer valid-user', 'x-user-id': 'forged' }));
  assert.deepEqual(plain(calls.limit[0]), ['owner-submit', { kind: 'user', id: ACTOR }]);
  assert.equal(calls.submit[0][0], ACTOR);
});

test('lookups: bounded input, owner-lookup limit, address search outage and nearby listings for the verified actor', async () => {
  const { handler, calls } = harness();
  assert.equal((await handler(get('address=ab'))).status, 400);
  assert.equal((await handler(get('latitude=35&longitude=139'))).status, 400);
  assert.equal(calls.limit.length, 0, 'invalid lookups do not consume quota');
  const found = await handler(get('address=12%20Fixture%20St'));
  assert.equal(found.status, 200); assert.equal(found.headers.get('cache-control'), 'private, no-store');
  assert.equal((await found.json()).candidates[0].city, 'Manila');
  assert.deepEqual(plain(calls.limit[0]), ['owner-lookup', { kind: 'user', id: ACTOR }]);
  const near = await handler(get('latitude=14.6&longitude=121&name=Corner'));
  assert.equal(near.status, 200); assert.deepEqual(calls.nearby[0], [ACTOR, 14.6, 121, 'Corner']);
  const unconfigured = harness({ geocode: null });
  assert.equal((await unconfigured.handler(get('address=Manila'))).status, 503);
  const failing = harness({ geocode: async () => { throw new Error('REQUEST_DENIED key=secret'); } });
  const failed = await failing.handler(get('address=Manila'));
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('retry-after'), '5'); assert.ok(!(await failed.text()).includes('secret'));
  assert.deepEqual(failing.calls.warn, ['address_search_failed']);
  const limited = harness({ limit: async () => ({ allowed: false, status: 429, state: 'enforced', headers: { 'Retry-After': '9' } }) });
  const blocked = await limited.handler(get('address=Manila'));
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '9'); assert.equal(limited.calls.geocode.length, 0);
});

test('submissions: limiter and outage run before upload/database; body, type and field bounds are enforced', async () => {
  for (const decision of [{ allowed: false, status: 429, state: 'enforced', headers: { 'Retry-After': '30' } },
    { allowed: false, status: 503, state: 'degraded', headers: { 'Retry-After': '5' } }]) {
    const { handler, calls } = harness({ limit: async () => decision });
    const response = await handler(post());
    assert.equal(response.status, decision.status); assert.equal(calls.upload.length + calls.submit.length, 0);
  }
  // The real guard with an unavailable Redis rejects owner commands (locked outage policy).
  const realGuard = createRateGuard({ backend: async () => { throw new Error('redis'); }, identifier: async () => 'hash', timeoutMs: 10 });
  const outage = harness({ limit: (action, principal) => realGuard(action, principal) });
  assert.equal((await outage.handler(post())).status, 503); assert.equal((await outage.handler(get('address=Manila'))).status, 503);
  assert.equal(outage.calls.upload.length + outage.calls.geocode.length, 0);
  const { handler, calls } = harness();
  assert.equal((await handler(new Request(url, { method: 'POST', body: '{}', headers: { authorization: 'Bearer valid-user', 'content-type': 'application/json' } }))).status, 415);
  assert.equal((await handler(new Request(url, { method: 'POST', body: 'x', headers: { authorization: 'Bearer valid-user', 'content-type': 'multipart/form-data; boundary=x', 'content-length': '99999999' } }))).status, 413);
  assert.equal((await handler(post(claim, new Uint8Array(5 * 1024 * 1024 + 1).fill(0xff)))).status, 413);
  assert.equal((await handler(post('not json'))).status, 400);
  assert.equal((await handler(post({ ...claim, actor_user_id: ACTOR }))).status, 400, 'authority fields rejected');
  assert.equal((await handler(post(claim, JPEG, { status: 'approved' }))).status, 400, 'extra parts rejected');
  assert.equal((await handler(post(claim, null))).status, 400, 'evidence required');
  for (const bytes of [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), new Uint8Array([0x47, 0x49, 0x46, 0x38]), new TextEncoder().encode('<svg/>')]) {
    assert.equal((await handler(post(claim, bytes))).status, 415);
  }
  assert.equal(calls.upload.length + calls.submit.length, 0, 'invalid submissions never touch storage or the database');
});

test('accepted evidence is stored privately under a server path; only created records keep their upload', async () => {
  const { handler, calls } = harness();
  const response = await handler(post());
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.submission.status, 'pending'); assert.ok(!JSON.stringify(body).includes('evidence'));
  assert.deepEqual(calls.upload[0].slice(0, 1), [`${ACTOR}/e1000000-0000-4000-8000-000000000001.jpg`]);
  assert.equal(calls.upload[0][2], 'image/jpeg', 'type from bytes, not the client-declared PNG');
  assert.equal(calls.submit[0][2], calls.upload[0][0]); assert.deepEqual(calls.remove, []);
  const outcomes = [
    [{ ...created, outcome: 'existing' }, 200, null],
    [{ outcome: 'duplicates', submission: null, duplicates: [{ id: VENUE, name: 'Venue', address_line: 'A', city: 'Manila', province: 'Metro Manila', claim_status: 'unclaimed', distance_m: 40 }] }, 409, 'possible_duplicates'],
  ];
  for (const [result, status, error] of outcomes) {
    const run = harness({ submit: async () => result });
    const reply = await run.handler(post());
    assert.equal(reply.status, status); if (error) assert.equal((await reply.json()).error, error);
    assert.deepEqual(run.calls.remove, [run.calls.upload[0][0]], 'redundant upload removed');
  }
  for (const [reason, status] of [['already_pending', 409], ['listing_unavailable', 404], ['too_many_pending', 409], ['already_verified', 409], ['actor_required', 403]]) {
    const run = harness({ submit: async () => { throw new CommandRejected(reason); } });
    const reply = await run.handler(post());
    assert.equal(reply.status, status); assert.equal(run.calls.remove.length, 1); assert.deepEqual(run.calls.warn, []);
  }
  const broken = harness({ submit: async () => { throw new Error('connection string secret'); }, remove: async () => { throw new Error('storage'); } });
  const failed = await broken.handler(post());
  assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes('secret'));
  assert.deepEqual(broken.calls.warn, ['submission_failed', 'evidence_cleanup_failed']);
  const noStorage = harness({ upload: async () => { throw new Error('bucket'); } });
  assert.equal((await noStorage.handler(post())).status, 503); assert.equal(noStorage.calls.submit.length, 0);
});

test('geocoding keeps Philippine results with bounded fields and keeps the key out of URLs', async () => {
  const result = (overrides = {}) => ({
    placeId: 'x', formattedAddress: '12 Fixture St, Poblacion, Makati City, Metro Manila, Philippines',
    location: { latitude: 14.56, longitude: 121.02 },
    addressComponents: [
      { longText: '12', shortText: '12', types: ['street_number'] }, { longText: 'Fixture Street', shortText: 'Fixture St', types: ['route'] },
      { longText: 'Poblacion', types: ['sublocality_level_1', 'sublocality'] }, { longText: 'Makati City', types: ['locality'] },
      { longText: 'Metro Manila', types: ['administrative_area_level_1'] }, { longText: 'Philippines', shortText: 'PH', types: ['country'] },
    ], ...overrides,
  });
  const parsed = parseGeocode({ results: [result(), result({ addressComponents: [{ shortText: 'JP', types: ['country'] }] }),
    result({ location: { latitude: 35.6, longitude: 139.7 } }), result({ formattedAddress: 'x'.repeat(241) }), ...Array(8).fill(result())] });
  assert.equal(parsed.length, 5);
  assert.deepEqual(plain(parsed[0]), { label: '12 Fixture St, Poblacion, Makati City, Metro Manila, Philippines', address_line: '12 Fixture Street, Poblacion', city: 'Makati City', province: 'Metro Manila', latitude: 14.56, longitude: 121.02 });
  assert.deepEqual(plain(parseGeocode({})), []);
  assert.throws(() => parseGeocode({ results: 'nope' }));
  const requests = [];
  const geocode = createGeocoder('server-key', async (input, init) => { requests.push([input, init]); return new Response(JSON.stringify({ results: [result()] })); });
  assert.equal((await geocode('12 Fixture St/Makati')).length, 1);
  assert.ok(!requests[0][0].includes('server-key')); assert.equal(requests[0][1].headers['X-Goog-Api-Key'], 'server-key');
  assert.ok(requests[0][0].startsWith('https://geocode.googleapis.com/v4/geocode/address/12%20Fixture%20St%2FMakati?regionCode=PH'));
  const denied = createGeocoder('server-key', async () => new Response('{"error":{"status":"PERMISSION_DENIED"}}', { status: 403 }));
  await assert.rejects(denied('Manila'));
});
