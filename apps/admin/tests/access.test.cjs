const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readConsoleAccess } = require('../src/lib/access.ts');

function client(roles = [], overrides = {}) {
  const calls = [];
  return {
    calls,
    auth: { getUser: async () => { calls.push('verify'); return { data: { user: { id: 'verified-user', email: 'test@example.invalid', user_metadata: { role: 'admin' }, app_metadata: { role: 'admin' } } }, error: null }; } },
    rpc: async (name) => { calls.push(name); return { data: [{ privileged_roles: roles, owned_venue_ids: ['venue-fixture'] }], error: null }; },
    ...overrides,
  };
}

test('only verified identity plus current database roles grants console access', async () => {
  for (const role of ['admin', 'moderator']) {
    const c = client([role]);
    const result = await readConsoleAccess(c);
    assert.deepEqual(result, { status: 'allowed', actorId: 'verified-user', email: 'test@example.invalid', roles: [role] });
    assert.deepEqual(c.calls, ['verify', 'my_account_access']);
  }
  assert.deepEqual(await readConsoleAccess(client()), { status: 'denied' });
  assert.deepEqual(await readConsoleAccess(client(['owner'])), { status: 'denied' });
});

test('missing/invalid user cannot query roles, even with a claimed admin identity', async () => {
  for (const verified of [
    { data: { user: null }, error: null },
    { data: { user: { id: 'forged' } }, error: { status: 401 } },
  ]) {
    const c = client(['admin'], { auth: { getUser: async () => verified } });
    assert.deepEqual(await readConsoleAccess(c), { status: 'guest' });
    assert.deepEqual(c.calls, []);
  }
});

test('revocation is visible on the next check without token refresh or memoization', async () => {
  const roles = ['admin'];
  const c = client(roles);
  assert.equal((await readConsoleAccess(c)).status, 'allowed');
  roles.length = 0;
  assert.deepEqual(await readConsoleAccess(c), { status: 'denied' });
  assert.equal(c.calls.filter((name) => name === 'my_account_access').length, 2);
});

test('operation-specific role requirement denies moderators administrator capability', async () => {
  assert.deepEqual(await readConsoleAccess(client(['moderator']), 'admin'), { status: 'denied' });
  assert.equal((await readConsoleAccess(client(['admin']), 'admin')).status, 'allowed');
  assert.equal((await readConsoleAccess(client(['admin']), 'moderator')).status, 'allowed');
});

test('verification/database outages and malformed role responses fail closed', async () => {
  assert.deepEqual(await readConsoleAccess(client(['admin'], { auth: { getUser: async () => { throw new Error('private-details'); } } })), { status: 'unavailable' });
  for (const status of [0, 429, 503]) assert.deepEqual(await readConsoleAccess(client(['admin'], { auth: { getUser: async () => ({ error: { status } }) } })), { status: 'unavailable' });
  for (const response of [{ data: null, error: { code: 'private-error' } }, { data: [], error: null }, { data: [{ privileged_roles: null }], error: null }]) {
    assert.deepEqual(await readConsoleAccess(client(['admin'], { rpc: async () => response })), { status: 'unavailable' });
  }
});
