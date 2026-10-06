const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { requestEmailCode, verifyEmailCode, signInApple, authMessage } = require('../actions.ts');

function auth() {
  const calls = [];
  const client = Object.fromEntries(['signInWithOtp', 'verifyOtp', 'signInWithIdToken', 'updateUser'].map((name) => [name, async (input) => {
    calls.push({ name, input });
    return { data: { session: { user: { id: 'fixture-user' } } }, error: null };
  }]));
  return { client, calls };
}

test('email code requests normalize input and verification uses the email OTP contract', async () => {
  const a = auth();
  await requestEmailCode(a.client, ' Player@Example.com ');
  await verifyEmailCode(a.client, ' Player@Example.com ', ' 123456 ');
  assert.deepEqual(a.calls.map((call) => call.input), [
    { email: 'player@example.com', options: { shouldCreateUser: true } },
    { email: 'player@example.com', token: '123456', type: 'email' },
  ]);
  await assert.rejects(requestEmailCode(a.client, 'not-an-email'));
  await assert.rejects(verifyEmailCode(a.client, 'player@example.com', '123abc'));
  assert.equal(a.calls.length, 2);
});

test('wrong/expired codes, rate limits and provider errors get safe actionable messages', async () => {
  const a = auth();
  a.client.verifyOtp = async () => ({ data: { session: null }, error: { code: 'otp_expired', message: 'private-detail' } });
  await assert.rejects(verifyEmailCode(a.client, 'player@example.com', '123456'), /incorrect or expired/);
  assert.match(authMessage({ code: 'over_email_send_rate_limit' }), /wait/);
  assert.match(authMessage({ code: 'provider_disabled' }), /try email/);
  assert.ok(!authMessage({ message: 'private-detail' }).includes('private-detail'));
});

test('Apple receives a hashed nonce; Supabase receives the original nonce and identity token', async () => {
  const a = auth();
  const raw = crypto.randomUUID();
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  let sent;
  const result = await signInApple(a.client, {
    nonce: () => raw,
    hash: async (nonce) => crypto.createHash('sha256').update(nonce).digest('hex'),
    signIn: async (nonce) => { sent = nonce; return { identityToken: 'apple-fixture-only', fullName: 'Test Player' }; },
  });
  assert.equal(result, true);
  assert.equal(sent, hashed);
  assert.deepEqual(a.calls[0].input, { provider: 'apple', token: 'apple-fixture-only', nonce: raw });
  assert.deepEqual(a.calls[1].input, { data: { full_name: 'Test Player' } });
});

test('Apple cancellation/missing tokens never exchange a credential with Supabase', async () => {
  const a = auth();
  const port = { nonce: () => 'fixture-nonce', hash: async () => 'hashed-fixture' };
  assert.equal(await signInApple(a.client, { ...port, signIn: async () => { throw { code: 'ERR_REQUEST_CANCELED' }; } }), false);
  await assert.rejects(signInApple(a.client, { ...port, signIn: async () => ({ identityToken: null }) }), /did not return/);
  assert.equal(a.calls.length, 0);
});

test('provider validation and a real session are required before Apple sign-in succeeds', async () => {
  const a = auth();
  a.client.signInWithIdToken = async () => ({ data: { session: null }, error: { code: 'provider_disabled' } });
  await assert.rejects(signInApple(a.client, {
    nonce: () => 'fixture', hash: async () => 'hashed', signIn: async () => ({ identityToken: 'fixture' }),
  }), /try email/);
});
