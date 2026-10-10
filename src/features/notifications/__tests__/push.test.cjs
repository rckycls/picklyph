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
  const muted = new Map();
  const handler = handlerModule.createPushDevicesHandler({ verifyUser: async (bearer) => bearer === 'token-1' ? actor : bearer === 'token-2' ? other : null,
    limit: async () => allowed, register: async (who, command) => { steps.push(['register', who, plain(command)]); },
    unregister: async (who, command) => { steps.push(['unregister', who, plain(command)]); },
    readPreferences: async (who) => ({ muted: muted.get(who) ?? [] }),
    savePreferences: async (who, topics) => { steps.push(['save', who, plain(topics)]); muted.set(who, topics); return { muted: topics }; }, ...overrides });
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
  assert.equal(label({ permission: 'granted', status: 'registered' }), 'On for this phone · choose which alerts');
  assert.equal(label({ permission: 'granted', status: 'paused' }), 'Turning off while you sign out…');
  assert.equal(label({ permission: 'undetermined', status: 'off' }), 'Off · tap to get booking updates on this phone');
  assert.equal(label({ permission: 'denied', status: 'off' }), 'Off · open Settings to allow notifications');
  assert.equal(label({ permission: 'unavailable', status: 'off' }), 'Not available in this version of the app');
  assert.equal(label({ permission: 'granted', status: 'failed', failure: null }), 'Not available on this phone yet · tap to try again');
  assert.equal(label({ permission: 'granted', status: 'failed', failure: { kind: 'network', retryAfterSeconds: null } }), 'Couldn’t turn on · tap to try again');
  assert.equal(label({ permission: 'granted', status: 'failed', failure: { kind: 'rate_limited', retryAfterSeconds: 12 } }), 'Couldn’t turn on · try again in 12 seconds');
  assert.equal(label({ permission: 'granted', status: 'failed', failure: { kind: 'sign_in', retryAfterSeconds: null } }), 'Couldn’t turn on · sign in again, then try again');
});

test('alert preferences (T45): read and replaced through the real handler, for the bearer account only, replies checked', async () => {
  const steps = []; const transport = server(steps);
  assert.deepEqual(plain(await client.readAlertPreferences(transport())), { ok: true, value: { muted: [] } });
  assert.deepEqual(plain(await client.saveAlertPreferences(transport(), ['updates', 'reminders'])), { ok: true, value: { muted: ['reminders', 'updates'] } });
  assert.deepEqual(plain(await client.readAlertPreferences(transport())), { ok: true, value: { muted: ['reminders', 'updates'] } });
  assert.deepEqual(plain(await client.readAlertPreferences(transport('token-2'))), { ok: true, value: { muted: [] } }, 'another account has its own');
  assert.deepEqual(steps, [['save', actor, ['reminders', 'updates']]]);
  assert.throws(() => client.saveAlertPreferences(transport(), ['sms']));
  assert.equal((await client.readAlertPreferences(transport('expired'))).failure.kind, 'sign_in');
  const odd = (reply) => ({ ...transport(), fetch: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => reply }) });
  assert.equal((await client.saveAlertPreferences(odd({ muted: [] }), ['payments'])).ok, false, 'a reply that is not the set sent is not success');
  assert.equal((await client.readAlertPreferences(odd({ muted: ['payments'], user: actor }))).ok, false);
  const deleted = server([], { savePreferences: async () => { throw new handlerModule.PushDeviceRejected('account_deleted'); } });
  const refused = await client.saveAlertPreferences(deleted(), []);
  assert.equal(client.preferencesFailureMessage(refused.failure), 'This account is being deleted, so its alerts can’t change.');
  assert.equal(client.preferencesFailureMessage({ kind: 'rate_limited', retryAfterSeconds: 9 }), 'Too many changes just now. Try again in 9 seconds.');
  assert.equal(client.preferencesFailureMessage({ kind: 'network', retryAfterSeconds: null }), 'Couldn’t reach pickly, so your alerts didn’t change. Try again.');
});

test('switch changes go out one at a time and only the newest waiting set follows the one in flight', async () => {
  const sent = []; const settled = []; let release;
  const writer = client.createPreferencesWriter((muted) => { sent.push(muted); return new Promise((resolve) => { release = () => resolve({ ok: true, value: { muted } }); }); },
    (outcome) => settled.push(plain(outcome)));
  writer.write(['updates']); writer.write(['updates', 'payments']); writer.write(['payments']);
  assert.deepEqual(sent, [['updates']]); assert.equal(writer.busy, true);
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [['updates'], ['payments']], 'the middle set is skipped');
  assert.deepEqual(settled, [], 'an answer that a newer change superseded is not reported');
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settled, [{ ok: true, value: { muted: ['payments'] } }]); assert.equal(writer.busy, false);
  const failing = []; const broken = client.createPreferencesWriter(async () => { throw new Error('boom'); }, (outcome) => failing.push(plain(outcome)));
  broken.write([]); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failing, [{ ok: false, failure: { kind: 'network', retryAfterSeconds: null } }]);
});

test('sign-out release (T45): removes this phone from the account first, holds registration, and reports what it could not do', async () => {
  const memo = client.createRegistrationMemo();
  const granted = ports();
  await client.syncPushRegistration(granted.ports, memo, actor, false);
  granted.calls.length = 0;
  assert.deepEqual(plain(await client.releasePushRegistration(granted.ports, memo, actor)), { status: 'released' });
  assert.deepEqual(granted.steps.at(-1), ['unregister', actor, { kind: 'unregister', token }]);
  assert.deepEqual(granted.calls, [], 'the remembered token is used, without asking the phone again');
  assert.equal(memo.get('https://a.test', actor), null);
  // Held: a foreground return before sign-out finishes does not register again, reads no token and asks nothing.
  assert.deepEqual(plain(await client.syncPushRegistration(granted.ports, memo, actor, true)), { permission: 'granted', status: 'paused' });
  assert.equal(granted.steps.length, 2);
  assert.deepEqual(granted.calls, ['permission']);
  const unanswered = ports({ permission: async () => 'undetermined' }); const heldMemo = client.createRegistrationMemo();
  heldMemo.hold('https://a.test', actor);
  assert.deepEqual(plain(await client.syncPushRegistration(unanswered.ports, heldMemo, actor, true)), { permission: 'undetermined', status: 'paused' });
  assert.ok(!unanswered.calls.includes('request'), 'no system prompt while signing out');
  assert.deepEqual(plain(await client.syncPushRegistration(granted.ports, memo, other, false)), { permission: 'granted', status: 'registered' }, 'other accounts are not held');
  memo.unhold('https://a.test', actor);
  await client.syncPushRegistration(granted.ports, memo, actor, false);
  assert.deepEqual(granted.steps.at(-1), ['register', actor, { kind: 'register', token, platform: 'ios' }], 'an abandoned sign-out registers again');

  const cold = ports();
  assert.deepEqual(plain(await client.releasePushRegistration(cold.ports, client.createRegistrationMemo(), actor)), { status: 'released' });
  assert.deepEqual(cold.calls, ['permission', 'token'], 'with nothing remembered it reads the token, when alerts are allowed');
  for (const permission of ['undetermined', 'denied', 'unavailable']) {
    const off = ports({ permission: async () => permission });
    assert.deepEqual(plain(await client.releasePushRegistration(off.ports, client.createRegistrationMemo(), actor)), { status: 'none' }, permission);
    assert.ok(!off.calls.includes('token') && off.steps.length === 0, `${permission}: nothing to remove and no prompt`);
  }
  const noToken = ports({ token: async () => null });
  assert.deepEqual(plain(await client.releasePushRegistration(noToken.ports, client.createRegistrationMemo(), actor)), { status: 'failed', failure: null });

  const offlineMemo = client.createRegistrationMemo(); const offline = ports();
  await client.syncPushRegistration(offline.ports, offlineMemo, actor, false);
  offline.ports.transport = () => ({ endpoint: 'https://local.test', apiKey: 'anon', accessToken: async () => 'token-1', fetch: async () => { throw new Error('offline'); } });
  const failed = await client.releasePushRegistration(offline.ports, offlineMemo, actor);
  assert.equal(failed.status, 'failed'); assert.equal(failed.failure.kind, 'network');
  assert.equal(offlineMemo.get('https://a.test', actor), token, 'the account keeps its registration, so a retry knows the token');
  assert.match(client.releaseFailureMessage(failed.failure), /^You seem to be offline\. You can try again, or sign out anyway: this phone may keep showing booking alerts/);
  assert.match(client.releaseFailureMessage({ kind: 'rate_limited', retryAfterSeconds: 7 }), /^Too many tries just now\. Wait 7 seconds\./);
  assert.match(client.releaseFailureMessage(null), /^pickly couldn’t confirm it right now\./);
});

test('sign-out waits for a registration already on its way, and a registration that has not left yet never does', async () => {
  // In flight: the release waits for it to land, then removes it.
  const steps = []; const handler = server(steps); let land;
  const slow = { ...handler(), fetch: async (url, init) => { if (JSON.parse(init.body).kind === 'register') await new Promise((resolve) => { land = resolve; });
    return handler().fetch(url, init); } };
  const memo = client.createRegistrationMemo();
  const base = ports().ports; const p = { ...base, transport: () => slow };
  const syncing = client.syncPushRegistration(p, memo, actor, false);
  await new Promise((resolve) => setImmediate(resolve));
  const releasing = client.releasePushRegistration(p, memo, actor);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, [], 'nothing removed before the registration lands');
  land();
  assert.deepEqual(plain(await syncing), { permission: 'granted', status: 'paused' });
  assert.deepEqual(plain(await releasing), { status: 'released' });
  assert.deepEqual(steps.map(([kind]) => kind), ['register', 'unregister']);

  // Not sent yet: the token was still being read when sign-out began.
  let ready = false; const waiting = [];
  const late = ports({ token: () => ready ? Promise.resolve(token) : new Promise((resolve) => waiting.push(resolve)) });
  const lateMemo = client.createRegistrationMemo();
  const pending = client.syncPushRegistration(late.ports, lateMemo, actor, false);
  await new Promise((resolve) => setImmediate(resolve));
  const lateRelease = client.releasePushRegistration(late.ports, lateMemo, actor);
  ready = true; waiting.splice(0).forEach((resolve) => resolve(token));
  assert.deepEqual(plain(await pending), { permission: 'granted', status: 'paused' });
  assert.deepEqual(plain(await lateRelease), { status: 'released' });
  assert.deepEqual(late.steps.map(([kind]) => kind), ['unregister'], 'the held registration was never sent');
});

test('in-app banners only for the signed-in account; the booking-screen nudge only before iOS has asked', () => {
  const data = { notification_id: 'c4340000-0000-4000-8000-000000000001', kind: 'booking.accepted', audience: 'player', booking_kind: 'rental',
    booking_id: 'c4320000-0000-4000-8000-000000000001', venue_id: 'c4330000-0000-4000-8000-000000000001', starts_at: '2026-10-12T10:00:00Z', recipient: actor };
  assert.equal(client.shouldPresent(data, actor), true);
  assert.equal(client.shouldPresent(data, actor.toUpperCase()), true);
  assert.equal(client.shouldPresent(data, other), false, 'another account signed in');
  assert.equal(client.shouldPresent(data, null), false, 'signed out');
  assert.equal(client.shouldPresent({ ...data, kind: 'booking.nope' }, actor), false, 'unreadable data is not shown');
  assert.equal(client.shouldPresent(null, actor), false);
  assert.equal(client.showAlertsNudge('undetermined', false), true);
  for (const [permission, dismissed] of [['undetermined', true], ['undetermined', null], ['denied', false], ['granted', false], ['unavailable', false], [null, false]]) {
    assert.equal(client.showAlertsNudge(permission, dismissed), false, `${permission}/${dismissed}`);
  }
});
