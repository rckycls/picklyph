const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');

const root = path.resolve(path.dirname(module.filename), '../../../..');
const keys = require(path.join(root, 'src/lib/recoveryKeys.ts'));
const client = load(path.join(root, 'src/features/account/deletionClient.ts'), { '@picklyph/domain': require(path.join(root, 'packages/domain/src/privacy.ts')),
  '../owner/venueClient': require(path.join(root, 'src/features/owner/venueClient.ts')) });
const handlerModule = load(path.join(root, 'supabase/functions/account-deletion/handler.ts'), {}, { TextDecoder });

const actor = 'c4790000-0000-4000-8000-000000000001';
const other = 'c4790000-0000-4000-8000-000000000002';
const hosted = 'https://fkdusdurzdgbfwwigrqw.supabase.co';
const local = 'http://127.0.0.1:54321';
// The loader runs modules in their own realm; compare its objects as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('recovery keys cover every journal under both namespace forms, for this account only', async () => {
  assert.equal(keys.rentalRecoveryNamespace(hosted, actor), `pickly.fkdusdurzdgbfwwigrqw.${actor}`);
  assert.equal(keys.recoveryNamespace(hosted, actor), `pickly.fkdusdurzdgbfwwigrqw.supabase.co.${actor}`);
  assert.equal(keys.rentalRecoveryNamespace(local, actor), `pickly.127.${actor}`);
  assert.equal(keys.recoveryNamespace(local, actor), `pickly.127.0.0.1_54321.${actor}`);
  const all = keys.accountRecoveryKeys(hosted, actor);
  assert.equal(all.length, 10); assert.equal(new Set(all).size, 10);
  for (const expected of [`pickly.fkdusdurzdgbfwwigrqw.${actor}.rental-attempt`, `pickly.fkdusdurzdgbfwwigrqw.supabase.co.${actor}.group-attempt`,
    `pickly.fkdusdurzdgbfwwigrqw.supabase.co.${actor}.session-attempt`, `pickly.fkdusdurzdgbfwwigrqw.supabase.co.${actor}.walk-in-attempt`,
    `pickly.fkdusdurzdgbfwwigrqw.supabase.co.${actor}.owner-entry-attempt`]) assert.ok(all.includes(expected), expected);
  const values = new Map([...all, ...keys.accountRecoveryKeys(hosted, other), 'pickly.welcome'].map((key) => [key, 'saved']));
  const store = { remove: async (key) => { values.delete(key); } };
  await keys.clearAccountRecovery(store, hosted, actor);
  assert.deepEqual([...values.keys()].sort(), [...keys.accountRecoveryKeys(hosted, other), 'pickly.welcome'].sort(), 'other accounts and device data stay');
  let attempts = 0;
  const flaky = { remove: async (key) => { attempts++; if (key.endsWith('.group-attempt')) throw new Error('Keychain busy'); } };
  await assert.rejects(keys.clearAccountRecovery(flaky, hosted, actor)); assert.equal(attempts, 10, 'every key is still tried');
});

test('every device journal key and namespace is the one account deletion clears', () => {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      for (const match of fs.readFileSync(full, 'utf8').matchAll(/`\$\{namespace\}\.([a-z-]+)`/g)) found.add(match[1]);
    }
  };
  walk(path.join(root, 'src/features'));
  assert.deepEqual([...found].sort(), [...keys.ACCOUNT_RECOVERY_SUFFIXES].sort());
  for (const [file, helper] of [['src/features/rental/live.ts', 'rentalRecoveryNamespace(url, actor)'], ['src/features/openPlay/live.ts', 'recoveryNamespace(url, actor)'],
    ['src/features/owner/sessionLive.ts', 'recoveryNamespace(url, actor)'], ['src/features/owner/deskLive.ts', 'recoveryNamespace(url, actor)']]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(source.includes(`const namespace = ${helper};`), `${file} uses the shared namespace`);
    assert.ok(!source.includes('`pickly.'), `${file} builds no namespace of its own`);
  }
});

test('the typed confirmation is the word DELETE, ignoring case and spaces', () => {
  for (const text of ['DELETE', 'delete', '  Delete  ']) assert.equal(client.confirmationTyped(text), true, text);
  for (const text of ['', 'DELET', 'DELETE!', 'delete account', 'D E L E T E']) assert.equal(client.confirmationTyped(text), false, text);
});

test('the client sends only the confirmation body and reads the real handler replies; a lost reply is confirmed on retry', async () => {
  let mode = 'user'; let steps = []; let failBegin = null; let limitStatus = 200;
  const handler = handlerModule.createAccountDeletionHandler({
    verifyUser: async (token) => (token === 'token' ? (mode === 'user' ? { kind: mode, id: actor, apple: [] } : { kind: mode, id: actor }) : null),
    apple: null,
    limit: async () => (limitStatus === 200 ? { allowed: true, status: 200, state: 'enforced', headers: {} }
      : { allowed: false, status: 429, state: 'enforced', headers: { 'Retry-After': '12' } }),
    begin: async (id) => { if (failBegin) throw failBegin; steps.push(`begin:${id}`); },
    status: async () => 'deleted',
    removeFolder: async (bucket, folder) => { steps.push(`${bucket}/${folder}`); },
    deleteUser: async (id) => { steps.push(`delete:${id}`); },
  });
  const bodies = []; let loseReply = false; let token = 'token';
  const transport = { endpoint: 'https://local.test/functions/v1/account-deletion', apiKey: 'public', accessToken: async () => token,
    fetch: async (url, init) => {
      bodies.push(init.body);
      const response = await handler(new Request(url, init));
      if (loseReply) { loseReply = false; mode = 'missing'; throw new Error('Lost reply after commit'); }
      return { ok: response.ok, status: response.status, headers: response.headers, json: () => response.json() };
    } };
  assert.deepEqual(plain(await client.deleteAccount(transport)), { ok: true, value: { status: 'deleted' } });
  assert.deepEqual(steps, [`begin:${actor}`, `avatars/${actor}`, `owner-evidence/${actor}`, `delete:${actor}`]);
  assert.deepEqual(bodies, ['{"confirm":"delete_account"}']);
  // Lost reply after the deletion finished: the retry's token outlived the account and is confirmed from the deletion record.
  steps = []; loseReply = true;
  assert.equal((await client.deleteAccount(transport)).failure.kind, 'network');
  assert.deepEqual(plain(await client.deleteAccount(transport)), { ok: true, value: { status: 'deleted' } });
  assert.equal(steps.filter((step) => step.startsWith('delete:')).length, 1, 'the retry does no new deletion work');
  mode = 'user';
  failBegin = new handlerModule.DeletionRejected('privileged_account');
  const refused = await client.deleteAccount(transport);
  assert.deepEqual(plain(refused.failure), { kind: 'rejected', reason: 'privileged_account', retryAfterSeconds: null });
  assert.match(client.deletionFailureMessage(refused.failure), /another pickly administrator/);
  failBegin = new Error('down'); assert.equal((await client.deleteAccount(transport)).failure.kind, 'unavailable');
  failBegin = null; limitStatus = 429;
  assert.deepEqual(plain((await client.deleteAccount(transport)).failure), { kind: 'rate_limited', retryAfterSeconds: 12 });
  limitStatus = 200; token = 'stale';
  assert.equal((await client.deleteAccount(transport)).failure.kind, 'sign_in');
  token = null; const before = bodies.length;
  assert.equal((await client.deleteAccount(transport)).failure.kind, 'sign_in'); assert.equal(bodies.length, before, 'no request without a token');
  // A success that isn't exactly the documented reply is treated as uncertain.
  const odd = { ...transport, accessToken: async () => 'token', fetch: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ status: 'deleted', extra: 1 }) }) };
  assert.equal((await client.deleteAccount(odd)).failure.kind, 'unavailable');
  for (const failure of [{ kind: 'network', retryAfterSeconds: null }, { kind: 'unavailable', retryAfterSeconds: null }, { kind: 'sign_in', retryAfterSeconds: null },
    { kind: 'not_configured', retryAfterSeconds: null }, { kind: 'rate_limited', retryAfterSeconds: 3 }, { kind: 'rejected', reason: 'invalid_request', retryAfterSeconds: null }]) {
    assert.ok(client.deletionFailureMessage(failure).length > 10, failure.kind);
  }
  assert.match(client.deletionFailureMessage({ kind: 'network', retryAfterSeconds: null }), /trying again is safe/);
});

// T50a: the Apple step on the phone, driven through the real handler with a scripted Apple dependency.
const appleId = '001234.0f1e2d3c4b5a69788796a5b4c3d2e1f0.0412';
function appleWorld({ linked = true, refuse = new Set(), foreign = new Set() } = {}) {
  const steps = []; const bodies = [];
  const handler = handlerModule.createAccountDeletionHandler({
    verifyUser: async () => ({ kind: 'user', id: actor, apple: linked ? [appleId] : [] }),
    limit: async () => ({ allowed: true, status: 200, state: 'enforced', headers: {} }),
    begin: async (id) => { steps.push(`begin:${id}`); }, status: async () => 'none',
    removeFolder: async (bucket) => { steps.push(bucket); }, deleteUser: async () => { steps.push('delete'); },
    apple: { exchange: async (code) => { steps.push(`exchange:${code}`); return refuse.has(code) ? null : { subject: foreign.has(code) ? '000999.other.0001' : appleId, token: `refresh-${code}`, hint: 'refresh_token' }; },
      revoke: async (grant) => { steps.push(`revoke:${grant.token}`); } },
  });
  const transport = { endpoint: 'https://local.test/functions/v1/account-deletion', apiKey: 'public', accessToken: async () => 'token',
    fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); const r = await handler(new Request(url, init));
      return { ok: r.ok, status: r.status, headers: r.headers, json: () => r.json() }; } };
  return { steps, bodies, transport };
}
const codes = (...list) => { const asked = []; const source = async () => { const next = list.shift(); asked.push(next); if (next instanceof Error) throw next; return next; }; return { asked, source }; };

test('T50a: an Apple-linked account confirms with Apple once per tap and the code rides only in that request', async () => {
  const world = appleWorld(); const apple = codes('code-fresh-0001');
  assert.deepEqual(plain(await client.deleteAccountConfirmed(world.transport, true, apple.source)), { ok: true, value: { status: 'deleted' } });
  assert.equal(apple.asked.length, 1);
  assert.deepEqual(world.bodies, [{ confirm: 'delete_account', apple_authorization_code: 'code-fresh-0001' }]);
  assert.deepEqual(world.steps, ['exchange:code-fresh-0001', `begin:${actor}`, 'revoke:refresh-code-fresh-0001', 'avatars', 'owner-evidence', 'delete']);
  // Closing Apple's sheet, an Apple error or a malformed code sends nothing at all.
  for (const [answer, kind] of [[null, 'cancelled'], [new Error('Apple sheet failed'), 'failed'], ['has space in code', 'failed'], ['short', 'failed']]) {
    const quiet = appleWorld(); const attempt = await client.deleteAccountConfirmed(quiet.transport, true, codes(answer).source);
    assert.deepEqual(plain(attempt), { ok: false, apple: kind }, String(answer)); assert.deepEqual(quiet.bodies, []); assert.deepEqual(quiet.steps, []);
    assert.match(client.deletionAttemptMessage(attempt), /nothing was deleted/i);
  }
  // An email-only account never opens Apple's sheet.
  const email = appleWorld({ linked: false }); const never = codes(new Error('must not ask Apple'));
  assert.equal((await client.deleteAccountConfirmed(email.transport, false, never.source)).ok, true);
  assert.equal(never.asked.length, 0); assert.deepEqual(email.bodies, [{ confirm: 'delete_account' }]);
});

test('T50a: when the server still asks for Apple, the phone asks Apple once more and then stops', async () => {
  // The phone didn't know the account had an Apple identity: the server's 409 brings up Apple's sheet once.
  const unknown = appleWorld(); const once = codes('code-late-0001');
  assert.equal((await client.deleteAccountConfirmed(unknown.transport, false, once.source)).ok, true);
  assert.deepEqual(unknown.bodies, [{ confirm: 'delete_account' }, { confirm: 'delete_account', apple_authorization_code: 'code-late-0001' }]);
  assert.equal(unknown.steps[0], 'exchange:code-late-0001', 'no deletion work before Apple confirmed');
  // A used or expired code (for example after a failed revocation) is refused; a second fresh code finishes it.
  const stale = appleWorld({ refuse: new Set(['code-used-00001']) }); const twice = codes('code-used-00001', 'code-new-000001');
  assert.equal((await client.deleteAccountConfirmed(stale.transport, true, twice.source)).ok, true); assert.equal(twice.asked.length, 2);
  // Refused twice in one tap: no third prompt, and a message that nothing was deleted.
  const stuck = appleWorld({ refuse: new Set(['code-used-00001', 'code-used-00002']) }); const both = codes('code-used-00001', 'code-used-00002', 'code-unused-0003');
  const refused = await client.deleteAccountConfirmed(stuck.transport, true, both.source);
  assert.deepEqual(plain(refused), { ok: false, failure: { kind: 'rejected', reason: 'apple_reauthorization_required', retryAfterSeconds: null } });
  assert.equal(both.asked.length, 2); assert.equal(stuck.bodies.length, 2); assert.ok(!stuck.steps.some((s) => s.startsWith('begin')));
  assert.match(client.deletionAttemptMessage(refused), /nothing was deleted/);
  // Another Apple ID: refused with its own message, no second prompt.
  const foreign = appleWorld({ foreign: new Set(['code-other-0001']) }); const other = codes('code-other-0001', 'code-unused-0002');
  const mismatch = await client.deleteAccountConfirmed(foreign.transport, true, other.source);
  assert.deepEqual(plain(mismatch.failure), { kind: 'rejected', reason: 'apple_account_mismatch', retryAfterSeconds: null }); assert.equal(other.asked.length, 1);
  assert.match(client.deletionAttemptMessage(mismatch), /Apple ID you sign in with/); assert.deepEqual(foreign.steps, ['exchange:code-other-0001']);
  // A cancelled re-prompt sends nothing more.
  const cancelled = appleWorld(); const closed = codes(null);
  assert.deepEqual(plain(await client.deleteAccountConfirmed(cancelled.transport, false, closed.source)), { ok: false, apple: 'cancelled' });
  assert.equal(cancelled.bodies.length, 1);
});

test('T50a: the phone recognises Apple sign-in from the session user; the code is never saved or logged', () => {
  for (const user of [{ identities: [{ provider: 'email' }, { provider: 'apple' }] }, { app_metadata: { provider: 'apple' } }, { app_metadata: { provider: 'email', providers: ['email', 'apple'] } }])
    assert.equal(client.usesAppleSignIn(user), true, JSON.stringify(user));
  for (const user of [null, undefined, {}, { identities: null }, { identities: [{ provider: 'email' }], app_metadata: { provider: 'email', providers: ['email'] } }, { app_metadata: { providers: 'apple' } }])
    assert.equal(client.usesAppleSignIn(user), false, JSON.stringify(user));
  for (const file of ['src/features/account/deletionClient.ts', 'src/features/account/DeleteAccount.tsx', 'src/features/account/deletionLive.ts', 'src/features/auth/apple.native.ts',
    'supabase/functions/account-deletion/handler.ts', 'supabase/functions/account-deletion/deps.ts', 'supabase/functions/account-deletion/index.ts', 'supabase/functions/_shared/apple.ts']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!/console\.|SecureStore|attemptStore\.(?:save|write|set)|AsyncStorage/.test(source), `${file} neither logs nor stores the Apple code`);
  }
  assert.deepEqual([...client.DELETION_REJECTIONS], ['invalid_request', 'privileged_account', 'apple_reauthorization_required', 'apple_account_mismatch']);
});
