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
    verifyUser: async (token) => (token === 'token' ? { kind: mode, id: actor } : null),
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
