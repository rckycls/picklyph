const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLimiter, LimiterUnavailable, PRELAUNCH_LIMITS } = require('../src/lib/limits.ts');
const { createTurnstileVerifier, TurnstileUnavailable, TURNSTILE_VERIFY_URL } = require('../src/lib/turnstile.ts');
const { createEmailSender, EmailUnavailable, registrationEmail, limitEmail } = require('../src/lib/email.ts');
const { generateClaimCode, hashClaimCode } = require('../src/lib/claim-code.ts');
const { CLAIM_CODE_ALPHABET, normalizeClaimCode } = require('@picklyph/domain/src/prelaunch.ts');

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('limits: one atomic multi-exec per check with a keyed identifier; over the limit gives Retry-After', async () => {
  const counts = new Map();
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    const [[, key, , , window], [, incrKey], [, ttlKey]] = JSON.parse(init.body);
    assert.equal(key, incrKey); assert.equal(key, ttlKey);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return jsonResponse([{ result: counts.get(key) === 1 ? 'OK' : null }, { result: counts.get(key) }, { result: Number(window) - 1000 }]);
  };
  const limit = createLimiter({ environment: 'staging', url: 'https://unit.upstash.io', token: 'unit-token', salt: 'u'.repeat(32) }, fake);
  for (let n = 1; n <= PRELAUNCH_LIMITS['prelaunch-register'].ip.max; n++) assert.deepEqual(await limit('prelaunch-register', 'ip', '203.0.113.9'), { allowed: true });
  assert.deepEqual(await limit('prelaunch-register', 'ip', '203.0.113.9'), { allowed: false, retryAfter: 599 });
  assert.deepEqual(await limit('prelaunch-register', 'email', 'ana@example.ph'), { allowed: true }, 'separate buckets');
  assert.equal(seen[0].url, 'https://unit.upstash.io/multi-exec');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer unit-token');
  const commands = JSON.parse(seen[0].init.body);
  assert.deepEqual(commands.map((command) => command[0]), ['SET', 'INCR', 'PTTL']);
  assert.match(commands[0][1], /^pickly:staging:prelaunch-register:ip:[0-9a-f]{64}$/);
  assert.deepEqual(commands[0].slice(2), ['0', 'PX', '600000', 'NX']);
  for (const call of seen) assert.ok(!call.init.body.includes('203.0.113.9') && !call.init.body.includes('ana@example.ph'), 'Redis never sees the IP or email');
  const other = createLimiter({ environment: 'staging', url: 'https://unit.upstash.io', token: 't', salt: 'v'.repeat(32) }, fake);
  await other('prelaunch-register', 'ip', '203.0.113.9');
  assert.notEqual(JSON.parse(seen.at(-1).init.body)[0][1], commands[0][1], 'the salt keys the identifier');
});

test('limits fail closed on a missing config, HTTP errors, discarded transactions, odd replies and timeouts', async () => {
  const settings = { environment: 'local', url: 'http://127.0.0.1:1', token: 't', salt: 's'.repeat(32) };
  await assert.rejects(createLimiter(null)('prelaunch-lookup', 'ip', 'shared'), LimiterUnavailable);
  for (const fake of [
    async () => jsonResponse({ error: 'ERR unauthorized' }, 401),
    async () => jsonResponse({ error: 'ERR max daily request limit exceeded' }),
    async () => jsonResponse([{ result: 'OK' }, { error: 'WRONGTYPE' }, { result: 1000 }]),
    async () => jsonResponse([{ result: 'OK' }, { result: '1' }, { result: 1000 }]),
    async () => jsonResponse([{ result: 'OK' }, { result: 1 }]),
    async () => new Response('not json'),
    async () => { throw new TypeError('fetch failed'); },
    (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  ]) await assert.rejects(createLimiter(settings, fake, 50)('prelaunch-lookup', 'ip', 'shared'), LimiterUnavailable);
  await assert.rejects(createLimiter(settings)('prelaunch-lookup', 'email', 'x'), /Unknown limit/);
});

test('Turnstile: real results need our hostname and action; testing keys pass only outside production; outages throw', async () => {
  const sent = [];
  const verifier = (environment, reply, status = 200) => createTurnstileVerifier({ environment, secret: 'unit-secret', hostname: 'register.pickly.example' },
    async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return typeof reply === 'function' ? reply() : jsonResponse(reply, status); });
  const real = { success: true, hostname: 'register.pickly.example', action: 'register', 'error-codes': [] };
  assert.equal(await verifier('production', real)('tok', '203.0.113.9'), true);
  assert.deepEqual(sent[0], { url: TURNSTILE_VERIFY_URL, body: { secret: 'unit-secret', response: 'tok', remoteip: '203.0.113.9' } });
  assert.equal(await verifier('production', real)('tok', null), true);
  assert.deepEqual(sent[1].body, { secret: 'unit-secret', response: 'tok' }, 'no remoteip without a trusted client IP');
  assert.equal(await verifier('production', { ...real, hostname: 'evil.example' })('tok', null), false);
  assert.equal(await verifier('production', { ...real, action: 'login' })('tok', null), false);
  assert.equal(await verifier('production', { success: false, 'error-codes': ['timeout-or-duplicate'] })('tok', null), false);
  assert.equal(await verifier('production', { success: false, 'error-codes': ['invalid-input-response'] })('tok', null), false);
  const testing = { success: true, hostname: 'example.com', 'error-codes': [], metadata: { result_with_testing_key: true } };
  assert.equal(await verifier('local', testing)('XXXX.DUMMY.TOKEN.XXXX', null), true);
  assert.equal(await verifier('staging', testing)('XXXX.DUMMY.TOKEN.XXXX', null), true);
  assert.equal(await verifier('production', testing)('XXXX.DUMMY.TOKEN.XXXX', null), false);
  for (const outage of [
    verifier('production', { success: false, 'error-codes': ['invalid-input-secret'] }), verifier('production', { success: false, 'error-codes': ['internal-error'] }),
    verifier('production', {}, 500), verifier('production', { ok: true }), verifier('production', () => { throw new TypeError('fetch failed'); }),
    verifier('production', () => new Response('<html>')), createTurnstileVerifier(null),
  ]) await assert.rejects(outage('tok', null), TurnstileUnavailable);
});

test('email: the provider request carries the message, an idempotency key and the API key only in a header', async () => {
  const seen = [];
  const send = createEmailSender({ apiUrl: 'https://api.resend.com/emails', apiKey: 're_unit', from: 'pickly <hello@pickly.example>', replyTo: 'hello@pickly.example' },
    async (url, init) => { seen.push({ url, init }); return jsonResponse({ id: 'x' }); });
  await send({ to: 'ana@example.ph', subject: 'S', text: 'T', html: '<p>H</p>', idempotencyKey: 'prelaunch-1-v1' });
  assert.equal(seen[0].url, 'https://api.resend.com/emails');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer re_unit');
  assert.equal(seen[0].init.headers['Idempotency-Key'], 'prelaunch-1-v1');
  assert.deepEqual(JSON.parse(seen[0].init.body), { from: 'pickly <hello@pickly.example>', to: ['ana@example.ph'], reply_to: 'hello@pickly.example', subject: 'S', text: 'T', html: '<p>H</p>' });
  assert.ok(!seen[0].init.body.includes('re_unit'));
  for (const fake of [async () => jsonResponse({ message: 'invalid' }, 422), async () => jsonResponse({}, 500), async () => { throw new TypeError('fetch failed'); }]) {
    await assert.rejects(createEmailSender({ apiUrl: 'https://api.resend.com/emails', apiKey: 'k', from: 'a@b.cd', replyTo: 'a@b.cd' }, fake)({ to: 'a@b.cd', subject: 's', text: 't', html: 'h', idempotencyKey: 'k' }), EmailUnavailable);
  }
  await assert.rejects(createEmailSender(null)({ to: 'a@b.cd', subject: 's', text: 't', html: 'h', idempotencyKey: 'k' }), EmailUnavailable);
});

test('email content: venue, formatted code, next steps, removal contact and escaped HTML', () => {
  const message = registrationEmail({ ownerName: 'Ana <b>', venueName: 'Rizal & Sons Courts', code: 'ABCDEFGHJK', contactEmail: 'hello@pickly.example', origin: 'https://register.pickly.example' });
  assert.equal(message.subject, 'Your pickly claim code for Rizal & Sons Courts');
  for (const part of ['Rizal & Sons Courts', 'ABCDE-FGHJK', 'get the pickly app', 'Sign in', 'Open Account and enter this code', 'hello@pickly.example',
    '180 days', 'https://register.pickly.example/privacy', 'works once']) assert.ok(message.text.includes(part), `text has ${part}`);
  assert.ok(message.html.includes('Rizal &amp; Sons Courts') && message.html.includes('Ana &lt;b&gt;') && !message.html.includes('<b>,'));
  assert.ok(message.html.includes('ABCDE-FGHJK'));
  const notice = limitEmail({ venueName: 'Rizal Courts', contactEmail: 'hello@pickly.example', origin: 'https://register.pickly.example', max: 10 });
  assert.match(notice.text, /already has 10 registrations waiting to be claimed/);
  assert.ok(!/[A-Z2-9]{5}-[A-Z2-9]{5}/.test(notice.text));
});

test('claim codes: 10 symbols from the unambiguous alphabet, unbiased sampling, keyed hashes', async () => {
  for (let n = 0; n < 200; n++) {
    const code = generateClaimCode();
    assert.equal(code.length, 10);
    assert.equal(normalizeClaimCode(code), code);
  }
  // Bytes at or above 240 (8 × 30) are skipped, so every symbol stays equally likely.
  const scripted = [Uint8Array.from([255, 240, 0, 29, 30, 239, 241, 59, 60, 1, 2, 3, 4, 5, 6, 7]), Uint8Array.from(Array(16).fill(8))];
  assert.equal(generateClaimCode(() => scripted.shift()), CLAIM_CODE_ALPHABET[0] + CLAIM_CODE_ALPHABET[29] + CLAIM_CODE_ALPHABET[0] + CLAIM_CODE_ALPHABET[29]
    + CLAIM_CODE_ALPHABET[29] + CLAIM_CODE_ALPHABET[0] + CLAIM_CODE_ALPHABET[1] + CLAIM_CODE_ALPHABET[2] + CLAIM_CODE_ALPHABET[3] + CLAIM_CODE_ALPHABET[4]);
  const a = await hashClaimCode('s'.repeat(32), 'ABCDEFGHJK');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, await hashClaimCode('s'.repeat(32), 'ABCDEFGHJK'));
  assert.notEqual(a, await hashClaimCode('t'.repeat(32), 'ABCDEFGHJK'));
  assert.notEqual(a, await hashClaimCode('s'.repeat(32), 'ABCDEFGHJM'));
});
