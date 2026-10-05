const assert = require('node:assert/strict');
const { test } = require('node:test');
const { locateUser, readForegroundPermission } = require('../../../lib/location.ts');

const position = { latitude: 14.6, longitude: 121 };
const granted = { granted: true, canAskAgain: true };
const blocked = { granted: false, canAskAgain: false };

function client(overrides = {}) {
  return {
    servicesEnabled: async () => true,
    getPermission: async () => granted,
    requestPermission: async () => { throw new Error('Unexpected permission prompt'); },
    recentPosition: async () => null,
    currentPosition: async () => position,
    ...overrides,
  };
}

test('a permanent denial never requests permission or reads position', async () => {
  const api = client({
    getPermission: async () => blocked,
    recentPosition: async () => { throw new Error('Unexpected position read'); },
    currentPosition: async () => { throw new Error('Unexpected position read'); },
  });
  assert.deepEqual(await locateUser(api), { status: 'denied', canAskAgain: false });
});

test('declining the foreground prompt never reads position', async () => {
  let prompts = 0;
  const api = client({
    getPermission: async () => ({ granted: false, canAskAgain: true }),
    requestPermission: async () => { prompts++; return blocked; },
    recentPosition: async () => { throw new Error('Unexpected position read'); },
  });
  assert.deepEqual(await locateUser(api), { status: 'denied', canAskAgain: false });
  assert.equal(prompts, 1);
});

test('disabled system services do not trigger a permission prompt', async () => {
  assert.deepEqual(await locateUser(client({ servicesEnabled: async () => false })), { status: 'disabled' });
});

test('granted permission uses a recent fix without another native position request', async () => {
  const api = client({
    recentPosition: async () => position,
    currentPosition: async () => { throw new Error('Unexpected live fix'); },
  });
  assert.deepEqual(await locateUser(api), { status: 'granted', coordinates: position });
});

test('a missing recent fix falls back to a fresh position', async () => {
  assert.deepEqual(await locateUser(client()), { status: 'granted', coordinates: position });
});

test('native errors leave location unavailable, rather than exposing an error or coordinates', async () => {
  assert.deepEqual(await locateUser(client({ currentPosition: async () => { throw new Error('Native failure'); } })), { status: 'unavailable' });
});

test('an unresolved position request times out and a late fix cannot revive the result', async () => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const result = await locateUser(client({ currentPosition: async () => pending }), 5);
  assert.deepEqual(result, { status: 'unavailable' });
  complete(position);
  await pending;
  assert.deepEqual(result, { status: 'unavailable' });
});

test('invalid native coordinates are never sent to the camera', async () => {
  for (const coordinates of [{ latitude: NaN, longitude: 121 }, { latitude: 91, longitude: 121 }, { latitude: 14, longitude: 181 }]) {
    assert.deepEqual(await locateUser(client({ currentPosition: async () => coordinates })), { status: 'unavailable' });
  }
});

test('returning from Settings can recheck granted, askable, or disabled state without a prompt', async () => {
  assert.deepEqual(await readForegroundPermission(client()), { status: 'granted' });
  assert.deepEqual(await readForegroundPermission(client({ getPermission: async () => ({ granted: false, canAskAgain: true }) })), { status: 'denied', canAskAgain: true });
  assert.deepEqual(await readForegroundPermission(client({ servicesEnabled: async () => false })), { status: 'disabled' });
});
