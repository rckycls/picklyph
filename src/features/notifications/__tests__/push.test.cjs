const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');

const root = path.resolve(path.dirname(module.filename), '../../../..');
const client = load(path.join(root, 'src/features/notifications/pushClient.ts'), { '@picklyph/domain': require(path.join(root, 'packages/domain/src/notification.ts')),
  '../owner/venueClient': require(path.join(root, 'src/features/owner/venueClient.ts')) });
const handlerModule = load(path.join(root, 'supabase/functions/push-devices/handler.ts'), {}, { TextDecoder });

const actor = 'c4370000-0000-4000-8000-000000000001';
const other = 'c4370000-0000-4000-8000-000000000002';
const token = 'ExponentPushToken[phone-1]';
const plain = (value) => JSON.parse(JSON.stringify(value));
const allowed = { allowed: true, status: 200, state: 'enforced', headers: {} };

// The shipped client against the real handler, with the account the bearer verifies to.
function server(steps, overrides = {}) {
  const handler = handlerModule.createPushDevicesHandler({ verifyUser: async (bearer) => bearer === 'token-1' ? actor : bearer === 'token-2' ? other : null,
    limit: async () => allowed, register: async (who, command) => { steps.push(['register', who, plain(command)]); },
    unregister: async (who, command) => { steps.push(['unregister', who, plain(command)]); }, ...overrides });
  return (bearer = 'token-1') => ({ endpoint: 'https://local.test/functions/v1/push-devices', apiKey: 'anon', accessToken: async () => bearer,
    fetch: async (url, init) => { const response = await handler(new Request(url, init)); return { ok: response.ok, status: response.status, headers: response.headers, json: () => response.json() }; } });
}

test('the client registers and removes this phone with a strict body and parses only the expected reply', async () => {
  const steps = []; const transport = server(steps);
  assert.deepEqual(plain(await client.registerPushDevice(transport(), token, 'ios')), { ok: true, value: { status: 'registered' } });
  assert.deepEqual(plain(await client.unregisterPushDevice(transport(), token)), { ok: true, value: { status: 'removed' } });
  assert.deepEqual(steps, [['register', actor, { kind: 'register', token, platform: 'ios' }], ['unregister', actor, { kind: 'unregister', token }]]);
  // Another account's bearer registers to that account; the body never chooses one.
  await client.registerPushDevice(transport('token-2'), token, 'ios');
  assert.deepEqual(steps.at(-1), ['register', other, { kind: 'register', token, platform: 'ios' }]);
  assert.throws(() => client.registerPushDevice(transport(), 'not-a-token', 'ios'));
  assert.equal((await client.registerPushDevice(transport('expired'), token, 'ios')).failure.kind, 'sign_in');
  const deleted = server([], { register: async () => { throw new handlerModule.PushDeviceRejected('account_deleted'); } });
  assert.deepEqual(plain((await client.registerPushDevice(deleted(), token, 'ios')).failure), { kind: 'rejected', reason: 'account_deleted', retryAfterSeconds: null });
  const odd = { ...transport(), fetch: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ status: 'registered', user: actor }) }) };
  assert.equal((await client.registerPushDevice(odd, token, 'ios')).ok, false, 'an unexpected reply is not success');
});

function ports(overrides = {}) {
  const calls = [];
  const steps = []; const transport = server(steps);
  return { calls, steps, ports: { backend: 'https://a.test', platform: 'ios',
    permission: async () => { calls.push('permission'); return 'granted'; }, request: async () => { calls.push('request'); return 'granted'; },
    token: async () => { calls.push('token'); return token; }, transport: (who) => transport(who === actor ? 'token-1' : 'token-2'), ...overrides } };
}

test('sync registers once per account and token per app run, never prompts unless asked, and reports why it is off', async () => {
  const memo = client.createRegistrationMemo();
  const granted = ports();
  assert.deepEqual(plain(await client.syncPushRegistration(granted.ports, memo, actor, false)), { permission: 'granted', status: 'registered' });
  assert.deepEqual(plain(await client.syncPushRegistration(granted.ports, memo, actor, false)), { permission: 'granted', status: 'registered' });
  assert.equal(granted.steps.length, 1, 'foreground returns do not re-send');
  assert.deepEqual(granted.calls, ['permission', 'token', 'permission']);
  await client.syncPushRegistration(granted.ports, memo, other, false);
  assert.equal(granted.steps.length, 2, 'a different account registers again');
  await client.syncPushRegistration({ ...granted.ports, backend: 'https://b.test' }, memo, actor, false);
  assert.equal(granted.steps.length, 3, 'a different backend registers again');
  memo.clear(); await client.syncPushRegistration(granted.ports, memo, actor, false);
  assert.equal(granted.steps.length, 4, 'a token change (memo cleared) registers again');

  const unasked = ports({ permission: async () => 'undetermined' });
  assert.deepEqual(plain(await client.syncPushRegistration(unasked.ports, client.createRegistrationMemo(), actor, false)), { permission: 'undetermined', status: 'off' });
  assert.ok(!unasked.calls.includes('request') && unasked.steps.length === 0, 'no prompt and no registration without a tap');
  const asked = ports({ permission: async () => 'undetermined' });
  assert.deepEqual(plain(await client.syncPushRegistration(asked.ports, client.createRegistrationMemo(), actor, true)), { permission: 'granted', status: 'registered' });
  const refused = ports({ permission: async () => 'undetermined', request: async () => 'denied' });
  assert.deepEqual(plain(await client.syncPushRegistration(refused.ports, client.createRegistrationMemo(), actor, true)), { permission: 'denied', status: 'off' });
  assert.equal(refused.steps.length, 0);
  const denied = ports({ permission: async () => 'denied' });
  await client.syncPushRegistration(denied.ports, client.createRegistrationMemo(), actor, true);
  assert.ok(!denied.calls.includes('request'), 'a denied permission is never re-prompted; Settings is the way back');
  const old = ports({ permission: async () => 'unavailable' });
  assert.deepEqual(plain(await client.syncPushRegistration(old.ports, client.createRegistrationMemo(), actor, true)), { permission: 'unavailable', status: 'off' });

  const noToken = ports({ token: async () => null });
  assert.deepEqual(plain(await client.syncPushRegistration(noToken.ports, client.createRegistrationMemo(), actor, false)), { permission: 'granted', status: 'failed', failure: null });
  const offline = ports(); const memoOffline = client.createRegistrationMemo();
  offline.ports.transport = () => ({ endpoint: 'https://local.test', apiKey: 'anon', accessToken: async () => 'token-1', fetch: async () => { throw new Error('offline'); } });
  const failed = await client.syncPushRegistration(offline.ports, memoOffline, actor, false);
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure.kind, 'network');
  assert.equal(memoOffline.get('https://a.test', actor), null, 'a failed registration is retried next time');
});

test('the Account row explains each state', () => {
  const label = client.bookingAlertsLabel;
  assert.equal(label(null), 'Checking…');
  assert.equal(label({ permission: 'granted', status: 'registered' }), 'On · requests, confirmations and cancellations');
  assert.equal(label({ permission: 'undetermined', status: 'off' }), 'Off · tap to get booking updates on this phone');
  assert.equal(label({ permission: 'denied', status: 'off' }), 'Off · open Settings to allow notifications');
  assert.equal(label({ permission: 'unavailable', status: 'off' }), 'Not available in this version of the app');
  assert.equal(label({ permission: 'granted', status: 'failed', failure: null }), 'Not available on this phone yet · tap to try again');
  assert.equal(label({ permission: 'granted', status: 'failed', failure: { kind: 'network', retryAfterSeconds: null } }), 'Couldn’t turn on · tap to try again');
  assert.equal(label({ permission: 'granted', status: 'failed', failure: { kind: 'rate_limited', retryAfterSeconds: 12 } }), 'Couldn’t turn on · try again in 12 seconds');
  assert.equal(label({ permission: 'granted', status: 'failed', failure: { kind: 'sign_in', retryAfterSeconds: null } }), 'Couldn’t turn on · sign in again, then try again');
});
