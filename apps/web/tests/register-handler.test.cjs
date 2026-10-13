const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRegisterHandler, RegisterRpcError } = require('../src/lib/register-handler.ts');
const { LimiterUnavailable } = require('../src/lib/limits.ts');
const { TurnstileUnavailable } = require('../src/lib/turnstile.ts');
const { EmailUnavailable } = require('../src/lib/email.ts');
const { generateClaimCode, hashClaimCode } = require('../src/lib/claim-code.ts');

const origin = 'https://register.pickly.example';
const secret = 'unit-code-secret-unit-code-secret-unit';
const registration = {
  owner_name: 'Ana Cruz', email: 'Ana@Example.PH', phone: '0917 123 4567', role: 'owner',
  venue: { name: 'Rizal Courts', address_line: '12 Mabini St', city: 'Makati', province: 'Metro Manila', latitude: 14.55, longitude: 121.02, court_count: 4 },
  courts: { indoor: false, covered: true, surface: null }, note: null, consent: true,
};
const body = (patch = {}) => ({ request_key: 'a1b2c3d4-0000-4000-8000-000000000001', turnstile_token: 'token', acknowledge_duplicates: false, registration, ...patch });
const post = (payload = body(), headers = {}) => new Request(`${origin}/api/register`, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload),
});
const result = (patch = {}) => ({ outcome: 'created', registration_id: 'b1000000-0000-4000-8000-000000000001', send: true, code_version: 1,
  venue_name: 'Rizal Courts', duplicates: [], ...patch });

/** Every dependency recorded; behaviour overridable per test. */
function harness(overrides = {}) {
  const calls = { turnstile: [], limits: [], register: [], sent: [], emails: [], logs: [] };
  const deps = {
    settings: () => ({ origin, contactEmail: 'hello@pickly.example' }),
    clientIp: () => '203.0.113.9',
    verifyTurnstile: async (token, ip) => { calls.turnstile.push([token, ip]); return true; },
    limit: async (action, kind, id) => { calls.limits.push([action, kind, id]); return { allowed: true }; },
    generateCode: () => generateClaimCode(),
    hashCode: (code) => hashClaimCode(secret, code),
    register: async (args) => { calls.register.push(args); return result(); },
    emailSent: async (id, version) => { calls.sent.push([id, version]); return true; },
    sendEmail: async (email) => { calls.emails.push(email); },
    log: (event) => calls.logs.push(event),
    ...overrides,
  };
  return { calls, handle: createRegisterHandler(deps) };
}
const json = async (response) => ({ status: response.status, body: await response.json(), headers: response.headers });
const codeIn = (email) => /([A-Z2-9]{5})-([A-Z2-9]{5})/.exec(email.text)?.slice(1).join('');

test('a new registration is verified, limited, stored with only the code hash and emailed once', async () => {
  const { calls, handle } = harness();
  const reply = await json(await handle(post()));
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { status: 'sent', venue_name: 'Rizal Courts' });
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.equal(reply.headers.get('set-cookie'), null);
  assert.deepEqual(calls.turnstile, [['token', '203.0.113.9']]);
  assert.deepEqual(calls.limits, [['prelaunch-register', 'ip', '203.0.113.9'], ['prelaunch-register', 'email', 'ana@example.ph']]);
  assert.equal(calls.register.length, 1);
  const stored = calls.register[0];
  assert.equal(stored.registration.email, 'ana@example.ph');
  assert.equal(stored.registration.phone, '+639171234567');
  assert.match(stored.code_hash, /^[0-9a-f]{64}$/);
  assert.equal(calls.emails.length, 1);
  const email = calls.emails[0];
  const code = codeIn(email);
  assert.ok(code, 'the email carries the code');
  assert.equal(await hashClaimCode(secret, code), stored.code_hash, 'the stored hash is of the emailed code');
  assert.equal(JSON.stringify(stored).includes(code), false, 'the database never receives the code');
  assert.equal(email.to, 'ana@example.ph');
  assert.match(email.subject, /Rizal Courts/);
  assert.equal(email.idempotencyKey, 'prelaunch-b1000000-0000-4000-8000-000000000001-v1');
  assert.ok(!email.idempotencyKey.includes(code));
  assert.deepEqual(calls.sent, [['b1000000-0000-4000-8000-000000000001', 1]]);
  assert.deepEqual(calls.logs, ['prelaunch.created']);
});

test('created, already-sent and at-limit registrations answer identically', async () => {
  const replies = [];
  for (const outcome of [result(), result({ outcome: 'existing', send: false, code_version: 2 }),
    result({ outcome: 'limit', registration_id: null, send: false, code_version: null })]) {
    const { calls, handle } = harness({ register: async () => outcome });
    const response = await handle(post());
    replies.push([response.status, await response.text(), [...response.headers].sort().join('|')]);
    if (outcome.outcome === 'existing') assert.equal(calls.emails.length, 0, 'no second email after delivery');
    if (outcome.outcome === 'limit') {
      assert.equal(calls.emails.length, 1);
      assert.equal(codeIn(calls.emails[0]), undefined, 'the limit notice carries no code');
      assert.match(calls.emails[0].text, /already has 10 registrations/);
      assert.equal(calls.sent.length, 0);
    }
  }
  assert.deepEqual(replies[1], replies[0]);
  assert.deepEqual(replies[2], replies[0]);
});

test('nearby approved listings come back without IDs or claim data, and nothing is emailed', async () => {
  const duplicates = [{ id: 'c1000000-0000-4000-8000-000000000001', name: 'Hall', address_line: '10 Mabini St', city: 'Makati',
    province: 'Metro Manila', claim_status: 'verified', distance_m: 42 }];
  const { calls, handle } = harness({ register: async () => result({ outcome: 'duplicates', registration_id: null, send: false, code_version: null, duplicates }) });
  const reply = await json(await handle(post()));
  assert.deepEqual(reply.body, { status: 'duplicates', duplicates: [{ name: 'Hall', address_line: '10 Mabini St', city: 'Makati', distance_m: 42 }] });
  assert.equal(calls.emails.length, 0);
});

test('a failed send says to try again; the retry rotates the code and the old one no longer matches', async () => {
  let attempt = 0;
  const hashes = [];
  const { calls, handle } = harness({
    register: async (args) => { hashes.push(args.code_hash); attempt++; return attempt === 1 ? result() : result({ outcome: 'existing', code_version: 2 }); },
    sendEmail: async (email) => { calls.emails.push(email); if (calls.emails.length === 1) throw new EmailUnavailable(); },
  });
  const first = await json(await handle(post()));
  assert.equal(first.status, 502);
  assert.equal(first.body.error, 'email_failed');
  assert.match(first.body.message, /try again/i);
  assert.equal(calls.sent.length, 0, 'no delivery recorded');
  const second = await json(await handle(post()));
  assert.equal(second.status, 200);
  const [lost, delivered] = calls.emails.map(codeIn);
  assert.notEqual(lost, delivered);
  assert.equal(await hashClaimCode(secret, delivered), hashes[1]);
  assert.notEqual(await hashClaimCode(secret, lost), hashes[1], 'the first code stopped working');
  assert.equal(calls.emails[1].idempotencyKey, 'prelaunch-b1000000-0000-4000-8000-000000000001-v2');
  assert.deepEqual(calls.sent, [['b1000000-0000-4000-8000-000000000001', 2]]);
  assert.ok(calls.logs.every((line) => !line.includes(lost) && !line.includes(delivered) && !line.includes('@')), 'logs carry no code or address');
});

test('a failed limit notice also says to try again, and a lost delivery record does not change the answer', async () => {
  const limited = harness({ register: async () => result({ outcome: 'limit', registration_id: null, send: false, code_version: null }),
    sendEmail: async () => { throw new EmailUnavailable(); } });
  assert.equal((await limited.handle(post())).status, 502);
  const lost = harness({ emailSent: async () => { throw new RegisterRpcError('PGRST000', null); } });
  const reply = await json(await lost.handle(post()));
  assert.deepEqual([reply.status, reply.body], [200, { status: 'sent', venue_name: 'Rizal Courts' }]);
  assert.ok(lost.calls.logs.includes('prelaunch.delivery_record_failed'));
});

test('cross-site, wrong-method, oversized, non-JSON and invalid requests stop before any check or write', async () => {
  const cases = [
    [post(body(), { Origin: 'https://attacker.example' }), 403],
    [new Request(`${origin}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'register.pickly.example' }, body: '{}' }), 403],
    [new Request(`${origin}/api/register`, { method: 'GET', headers: { Origin: origin } }), 405],
    [post(body(), { 'Content-Type': 'text/plain' }), 415],
    [post(JSON.stringify(body({ registration: { ...registration, note: 'x'.repeat(9000) } }))), 413],
    [post('{"request_key":'), 400],
    [post(body({ registration: { ...registration, consent: false } })), 400],
    [post(body({ actor_user_id: 'x' })), 400],
    [post(body({ turnstile_token: '' })), 400],
  ];
  for (const [request, status] of cases) {
    const { calls, handle } = harness();
    const response = await handle(request);
    assert.equal(response.status, status, `${request.method} → ${status}`);
    assert.deepEqual([calls.turnstile.length, calls.limits.length, calls.register.length, calls.emails.length], [0, 0, 0, 0]);
  }
  const { handle } = harness();
  const consent = await json(await handle(post(body({ registration: { ...registration, consent: false } }))));
  assert.match(consent.body.message, /privacy notice/);
});

test('Turnstile failures refuse (403) and outages fail closed (503) before limits or writes', async () => {
  const failed = harness({ verifyTurnstile: async () => false });
  const refused = await json(await failed.handle(post()));
  assert.deepEqual([refused.status, refused.body.error], [403, 'check_failed']);
  assert.deepEqual([failed.calls.limits.length, failed.calls.register.length], [0, 0]);
  const outage = harness({ verifyTurnstile: async () => { throw new TurnstileUnavailable(); } });
  const down = await json(await outage.handle(post()));
  assert.deepEqual([down.status, down.body.error], [503, 'unavailable']);
  assert.ok(down.headers.get('retry-after'));
  assert.deepEqual([outage.calls.limits.length, outage.calls.register.length], [0, 0]);
});

test('IP and email limits answer 429 alike with Retry-After, and a Redis outage fails closed with no write', async () => {
  const byIp = harness({ limit: async (action, kind) => { byIp.calls.limits.push(kind); return kind === 'ip' ? { allowed: false, retryAfter: 120 } : { allowed: true }; } });
  const ipReply = await json(await byIp.handle(post()));
  assert.deepEqual([ipReply.status, ipReply.headers.get('retry-after')], [429, '120']);
  assert.deepEqual(byIp.calls.limits, ['ip'], 'the email bucket is not spent when the IP is limited');
  const byEmail = harness({ limit: async (action, kind) => (kind === 'email' ? { allowed: false, retryAfter: 900 } : { allowed: true }) });
  const emailReply = await json(await byEmail.handle(post()));
  assert.deepEqual([emailReply.status, emailReply.headers.get('retry-after')], [429, '900']);
  assert.equal(emailReply.body.message, ipReply.body.message, 'the same words whichever limit applies');
  assert.equal(byEmail.calls.register.length, 0);
  const outage = harness({ limit: async () => { throw new LimiterUnavailable(); } });
  const down = await json(await outage.handle(post()));
  assert.deepEqual([down.status, outage.calls.register.length, outage.calls.emails.length], [503, 0, 0]);
  // Off Vercel there is no trusted client IP: everyone shares one bucket.
  const shared = harness({ clientIp: () => null });
  await shared.handle(post());
  assert.deepEqual(shared.calls.limits[0], ['prelaunch-register', 'ip', 'shared']);
  assert.deepEqual(shared.calls.turnstile[0], ['token', null]);
});

test('database answers map to safe replies; code collisions retry with a fresh code', async () => {
  for (const [error, status] of [[new RegisterRpcError('22023', 'invalid_input'), 400], [new RegisterRpcError('23505', 'request_reused'), 409],
    [new RegisterRpcError('PGRST301', null), 503], [new Error('network'), 503]]) {
    const { calls, handle } = harness({ register: async () => { throw error; } });
    const reply = await json(await handle(post()));
    assert.equal(reply.status, status);
    assert.equal(calls.emails.length, 0);
    assert.ok(!JSON.stringify(reply.body).includes('PGRST'), 'no database detail leaks');
  }
  let tries = 0;
  const hashes = [];
  const once = harness({ register: async (args) => { hashes.push(args.code_hash); tries++; if (tries === 1) throw new RegisterRpcError('23505', 'code_collision'); return result(); } });
  assert.equal((await once.handle(post())).status, 200);
  assert.equal(new Set(hashes).size, 2);
  assert.equal(await hashClaimCode(secret, codeIn(once.calls.emails[0])), hashes[1]);
  const always = harness({ register: async () => { throw new RegisterRpcError('23505', 'code_collision'); } });
  assert.equal((await always.handle(post())).status, 503);
  assert.equal(always.calls.emails.length, 0);
});

test('an unconfigured server answers 503 without touching anything', async () => {
  const { calls, handle } = harness({ settings: () => { throw new Error('missing'); } });
  const reply = await json(await handle(post()));
  assert.deepEqual([reply.status, reply.body.error], [503, 'unavailable']);
  assert.deepEqual([calls.turnstile.length, calls.limits.length, calls.register.length], [0, 0, 0]);
});
