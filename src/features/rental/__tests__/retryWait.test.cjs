const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { load } = require('./helpers.cjs');

test('retry controls block immediately, count down, reset for a new denial and clear their timer', () => {
  let tick = { failure: null, seconds: 0 }; let prior; let callback; let cleanup; let clock = 10000;
  const waitHook = load(path.join(path.dirname(module.filename), '../useRetryWait.ts'), { react: {
    useState: () => [tick, value => { tick = value; }],
    useEffect: (effect, deps) => { if (deps[0] !== prior) { cleanup?.(); prior = deps[0]; cleanup = effect(); } },
  } }, { Date: { now: () => clock }, setInterval: fn => { callback = fn; return 1; }, clearInterval: () => { callback = null; } });
  const first = { kind: 'rate_limited', retryAfterSeconds: 7 };
  assert.equal(waitHook.useRetryWait(first), 7);
  clock += 1000; callback(); assert.equal(waitHook.useRetryWait(first), 6);
  const second = { kind: 'unavailable', retryAfterSeconds: 5 };
  assert.equal(waitHook.useRetryWait(second), 5);
  clock += 5000; callback(); assert.equal(waitHook.useRetryWait(second), 0); assert.equal(callback, null);
  assert.equal(waitHook.useRetryWait(null), 0);
  assert.equal(waitHook.useRetryWait({ kind: 'network', retryAfterSeconds: null }), 0);
  cleanup?.();
});
