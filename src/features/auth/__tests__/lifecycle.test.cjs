const assert = require('node:assert/strict');
const { test } = require('node:test');
const { watchSession } = require('../lifecycle.ts');

const session = { user: { id: 'fixture-user' }, access_token: 'fixture-only' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  let resolve;
  let reject;
  const read = new Promise((yes, no) => { resolve = yes; reject = no; });
  const states = [];
  const counts = { start: 0, stop: 0, authCleanup: 0, appCleanup: 0 };
  let event = () => {};
  let change = () => {};
  const auth = {
    getSession: () => read,
    onAuthStateChange: (callback) => {
      event = callback;
      callback('INITIAL_SESSION', null);
      return { data: { subscription: { unsubscribe: () => { counts.authCleanup++; } } } };
    },
    startAutoRefresh: async () => { counts.start++; },
    stopAutoRefresh: async () => { counts.stop++; },
  };
  const app = { currentState: 'active', subscribe: (callback) => { change = callback; return () => { counts.appCleanup++; }; } };
  return { auth, app, states, counts, resolve, reject, event: (...args) => event(...args), change: (state) => change(state) };
}

test('restoration does not become a guest before its result; refresh follows app state', async (t) => {
  const h = harness();
  const stop = watchSession(h.auth, h.app, (state) => h.states.push(state));
  t.after(stop);
  assert.equal(h.states.length, 0);
  h.resolve({ data: { session }, error: null });
  await tick();
  assert.equal(h.states.at(-1).session, session);
  h.change('background');
  assert.equal(h.counts.stop, 1);
  h.change('active');
  assert.equal(h.counts.start, 3);
  h.event('TOKEN_REFRESHED', { ...session, access_token: 'new-fixture' });
  assert.equal(h.states.at(-1).session.access_token, 'new-fixture');
});

test('late restoration cannot resurrect a session after sign-out or overwrite new sign-in', async (t) => {
  for (const [event, expected] of [['SIGNED_OUT', null], ['SIGNED_IN', session]]) {
    const h = harness();
    const stop = watchSession(h.auth, h.app, (state) => h.states.push(state));
    t.after(stop);
    h.event(event, expected);
    h.resolve({ data: { session: event === 'SIGNED_OUT' ? session : null }, error: null });
    await tick();
    assert.equal(h.states.length, 1);
    assert.equal(h.states[0].session, expected);
  }
});

test('unmount removes listeners/stops refresh and ignores pending reads/events', async () => {
  const h = harness();
  const stop = watchSession(h.auth, h.app, (state) => h.states.push(state));
  stop();
  h.resolve({ data: { session }, error: null });
  h.event('SIGNED_IN', session);
  h.change('active');
  await tick();
  assert.equal(h.states.length, 0);
  assert.deepEqual(h.counts, { start: 1, stop: 1, authCleanup: 1, appCleanup: 1 });
});

test('restoration failures are recoverable and never expose error details or tokens', async (t) => {
  const h = harness();
  t.after(watchSession(h.auth, h.app, (state) => h.states.push(state)));
  h.reject(new Error('sensitive-fixture-detail'));
  await tick();
  assert.equal(h.states.at(-1).status, 'error');
  assert.equal(h.states.at(-1).session, null);
  assert.equal(h.states.at(-1).canClear, true);
  assert.ok(!JSON.stringify(h.states).includes('sensitive-fixture-detail'));
});

test('a stalled restoration times out without enabling destructive recovery on in-flight work', async (t) => {
  const h = harness();
  t.after(watchSession(h.auth, h.app, (state) => h.states.push(state), 5));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(h.states.at(-1).status, 'error');
  assert.ok(!h.states.at(-1).canClear);
  h.resolve({ data: { session: null }, error: null });
  await tick();
  assert.equal(h.states.at(-1).status, 'ready');
});
