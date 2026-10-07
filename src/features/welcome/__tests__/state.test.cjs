const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const load = require('../../../../supabase/tests/load-ts.cjs');
const { createWelcomeStore, isOrdinaryLaunch, welcomeDestination, WELCOME_KEY } = load(path.join(path.dirname(module.filename), '../state.ts'));
const memory = () => { const values = new Map(); return { values, getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); } }; };

test('first launch completes locally and survives a fresh app session without storing a role', async () => {
  const storage = memory(); const first = createWelcomeStore(storage);
  assert.equal(await first.shouldWelcome(null), true); first.complete();
  assert.equal(await first.shouldWelcome(null), false);
  assert.equal(await createWelcomeStore(storage).shouldWelcome(null), false);
  assert.equal(storage.values.get(WELCOME_KEY), 'done'); assert.equal(storage.values.size, 1);
  assert.equal(welcomeDestination('player'), '/'); assert.equal(welcomeDestination('owner'), '/account');
});

test('application deep links bypass welcome without consuming future ordinary first launch', async () => {
  const storage = memory(); const store = createWelcomeStore(storage);
  for (const url of ['picklyph://rental/booking/123', 'picklyph:///owner/claim/123', 'picklyph://account', 'https://pickly.example/rental/booking/123', 'exp://localhost:8081/--/rental/booking/123', 'not a url']) {
    assert.equal(isOrdinaryLaunch(url), false); assert.equal(await store.shouldWelcome(url), false);
  }
  assert.equal(await store.shouldWelcome(null), true); assert.equal(storage.values.size, 0);
});

test('Expo packager and development-client boot URLs still show first launch welcome', () => {
  for (const url of [null, 'exp://192.168.1.1:8081', 'exps://host/--/', 'picklyph://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081']) assert.equal(isOrdinaryLaunch(url), true);
});

test('read/write failures cannot trap users and a late read cannot reopen completed welcome', async () => {
  const failing = createWelcomeStore({ getItem: async () => { throw new Error('storage offline'); }, setItem: async () => { throw new Error('storage offline'); } });
  assert.equal(await failing.shouldWelcome(null), true); failing.complete();
  assert.equal(await failing.shouldWelcome(null), false); await new Promise(resolve => setImmediate(resolve));
  let reply; const raced = createWelcomeStore({ getItem: () => new Promise(resolve => { reply = resolve; }), setItem: async () => {} });
  const reading = raced.shouldWelcome(null); raced.complete(); reply(null);
  assert.equal(await reading, false);
});
