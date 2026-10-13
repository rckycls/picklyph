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

test('mobile/admin source never references the server Maps key, evidence bucket or owner command RPCs (except the console evidence route)', () => {
  // T17: the console's server-only evidence route is the one reader outside the function, and only of the bucket.
  const evidenceReader = path.join(root, 'apps/admin/src/lib/ownership-handler.ts');
  // T54b: the console sends new claim codes, so its settings reader (imported only by server-only modules) reads the code secret.
  const codeSender = path.join(root, 'apps/admin/src/lib/registrations.ts');
  const forbidden = /GOOGLE_MAPS_SERVER_API_KEY|owner-evidence|owner_submit_(claim|venue)|owner_duplicate_candidates|owner_registration_check|owner_redeem_registration|PRELAUNCH_CODE_SECRET/;
  const codeSenderImporters = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.next', '.expo', 'dist', '__tests__'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const text = fs.readFileSync(file, 'utf8');
        const allowed = file === evidenceReader ? text.replaceAll('owner-evidence', '') : file === codeSender ? text.replaceAll('PRELAUNCH_CODE_SECRET', '') : text;
        assert.ok(!forbidden.test(allowed), `Server-only owner detail in ${path.relative(root, file)}`);
        if (/from '(\.\/|@\/lib\/)registrations'/.test(text)) codeSenderImporters.push(file);
      }
    }
  }
  scan(path.join(root, 'src')); scan(path.join(root, 'apps/admin/src'));
  assert.ok(fs.readFileSync(evidenceReader, 'utf8').startsWith("import 'server-only';"), 'The evidence reader stays server-only.');
  assert.ok(codeSenderImporters.length > 0 && codeSenderImporters.every((file) => fs.readFileSync(file, 'utf8').startsWith("import 'server-only';")),
    'Only server-only modules import the code sender.');
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
  assert.equal((await handler(new Request(url, { method: 'POST', body: '{}', headers: { authorization: 'Bearer valid-user', 'content-type': 'text/plain' } }))).status, 415);
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

// T54 pre-launch claim codes.
const CODE = 'ABCDEFGHJK';
const hashCode = async (code) => `hash:${code}`;
const preview = { name: 'Claimable Courts', address_line: '12 Mabini St', city: 'Manila', province: 'Metro Manila', court_count: 4 };
const check = (body, headers = { authorization: 'Bearer valid-user' }) => new Request(url, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { ...headers, 'content-type': 'application/json' } });
const redemption = { kind: 'registration', request_id: REQUEST, code: 'abcde fghjk', note: null };
const leaks = async (response) => { const text = await response.text(); return text.includes(CODE) || text.includes('ABCDE-FGHJK') || text.includes('secret'); };

test('claim-code checks: JSON bodies only, the owner-code limit first, the venue for a right code and one answer for wrong or used codes', async () => {
  const checks = [];
  const answers = { [`hash:${CODE}`]: { outcome: 'valid', registration: preview, retry_after_seconds: null } };
  const { handler, calls } = harness({ hashCode, checkCode: async (...args) => { checks.push(args); return answers[args[1]] ?? { outcome: 'invalid', registration: null, retry_after_seconds: null }; } });
  const found = await handler(check({ code: 'abcde-fghjk' }));
  assert.equal(found.status, 200); assert.equal(found.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(plain(await found.json()), { registration: preview });
  assert.deepEqual(plain(calls.limit[0]), ['owner-code', { kind: 'user', id: ACTOR }]);
  assert.deepEqual(checks[0], [ACTOR, `hash:${CODE}`], 'the database sees the verified actor and only the hash');
  const wrong = await handler(check({ code: 'ABCDE-FGHJM' }));
  assert.equal(wrong.status, 404); assert.deepEqual(plain(await wrong.json()), { error: 'code_not_valid' });
  assert.equal((await handler(check({ code: 'ABCDE-FGHJ0' }))).status, 400, 'impossible codes never reach the database');
  for (const body of [{ code: CODE, extra: 1 }, { request_id: REQUEST }, 'not json', [CODE]]) {
    const reply = await handler(check(body)); assert.equal(reply.status, 400); assert.equal((await reply.json()).error, 'invalid_request');
  }
  assert.equal((await handler(check({ code: 'A'.repeat(300) }))).status, 413);
  assert.equal(checks.length, 2);
  assert.equal((await handler(check({ code: CODE }, {}))).status, 401);

  const locked = harness({ hashCode, checkCode: async () => ({ outcome: 'locked', registration: null, retry_after_seconds: 3540 }) });
  const refused = await locked.handler(check({ code: CODE }));
  assert.equal(refused.status, 429); assert.equal(refused.headers.get('retry-after'), '3540'); assert.equal((await refused.json()).error, 'code_locked');
  for (const [reason, status, error] of [['listing_unavailable', 404, 'listing_unavailable'], ['actor_required', 403, 'account_required']]) {
    const run = harness({ hashCode, checkCode: async () => { throw new CommandRejected(reason); } });
    const reply = await run.handler(check({ code: CODE }));
    assert.equal(reply.status, status); assert.equal((await reply.json()).error, error);
  }
  const broken = harness({ hashCode, checkCode: async () => { throw new Error(`connection secret ${CODE}`); } });
  const failed = await broken.handler(check({ code: CODE }));
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('retry-after'), '5'); assert.ok(!(await leaks(failed)));
  assert.deepEqual(broken.calls.warn, ['code_check_failed']);
  // No secret configured, a refusing limiter or a Redis outage: nothing is hashed or checked.
  const unconfigured = harness({ hashCode: null, checkCode: async () => assert.fail('checked without a secret') });
  const missing = await unconfigured.handler(check({ code: CODE }));
  assert.equal(missing.status, 503); assert.equal((await missing.json()).error, 'claim_codes_unavailable');
  for (const decision of [{ allowed: false, status: 429, state: 'enforced', headers: { 'Retry-After': '30' } }, { allowed: false, status: 503, state: 'degraded', headers: { 'Retry-After': '5' } }]) {
    const run = harness({ limit: async () => decision, hashCode: async () => assert.fail('hashed past the limiter'), checkCode: async () => assert.fail('checked past the limiter') });
    assert.equal((await run.handler(check({ code: CODE }))).status, decision.status);
  }
  const realGuard = createRateGuard({ backend: async () => { throw new Error('redis'); }, identifier: async () => 'hash', timeoutMs: 10 });
  const outage = harness({ limit: (action, principal) => realGuard(action, principal), hashCode, checkCode: async () => assert.fail('checked in an outage') });
  assert.equal((await outage.handler(check({ code: CODE }))).status, 503, 'owner-code fails closed');
});

test('code redemptions: hashed before any upload, the T15 evidence rules, and wrong, used or locked codes remove the upload', async () => {
  const { handler, calls } = harness({ hashCode });
  const reply = await handler(post(redemption));
  assert.equal(reply.status, 201);
  assert.deepEqual(plain(calls.limit[0]), ['owner-submit', { kind: 'user', id: ACTOR }]);
  assert.deepEqual(plain(calls.submit[0]), [ACTOR, { kind: 'registration', request_id: REQUEST, code: CODE, note: null },
    `${ACTOR}/e1000000-0000-4000-8000-000000000001.jpg`, `hash:${CODE}`]);
  assert.deepEqual(calls.remove, []);
  assert.equal((await handler(post({ ...claim }))).status, 201); assert.equal(calls.submit[1][3], null, 'claims carry no code hash');
  for (const [result, status, error, retry] of [
    [{ outcome: 'invalid', submission: null, duplicates: [], retry_after_seconds: null }, 404, 'code_not_valid', null],
    [{ outcome: 'locked', submission: null, duplicates: [], retry_after_seconds: 120 }, 429, 'code_locked', '120'],
    [{ ...created, outcome: 'existing' }, 200, null, null],
  ]) {
    const run = harness({ hashCode, submit: async () => result });
    const answer = await run.handler(post(redemption));
    assert.equal(answer.status, status); assert.equal(answer.headers.get('retry-after'), retry);
    if (error) assert.equal((await answer.json()).error, error);
    assert.deepEqual(run.calls.remove, [run.calls.upload[0][0]], 'the upload goes when no record was created');
  }
  const bad = harness({ hashCode });
  const malformed = await bad.handler(post({ ...redemption, code: 'ABCDE-FGHJ0' }));
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error, 'invalid_code');
  assert.equal((await bad.handler(post({ ...redemption, venue_id: VENUE }))).status, 400, 'unknown fields');
  assert.equal(bad.calls.upload.length + bad.calls.submit.length, 0);
  const unconfigured = harness({ hashCode: null });
  const missing = await unconfigured.handler(post(redemption));
  assert.equal(missing.status, 503); assert.equal((await missing.json()).error, 'claim_codes_unavailable');
  assert.equal(unconfigured.calls.upload.length + unconfigured.calls.submit.length, 0, 'no upload without the secret');
  const run = harness({ hashCode, submit: async () => { throw new CommandRejected('already_verified'); } });
  assert.equal((await run.handler(post(redemption))).status, 409); assert.equal(run.calls.remove.length, 1);
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
