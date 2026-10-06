const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { test } = require('node:test');
const { createSecureStorage } = require('../secureStorage.ts');

function storage() {
  const data = new Map();
  let generation = 0;
  let reject = () => false;
  const driver = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      if (reject(key)) throw new Error('Device storage unavailable');
      assert.ok(Buffer.byteLength(value) <= 2048, 'native payload stays below platform limit');
      data.set(key, value);
    },
    removeItem: async (key) => { data.delete(key); },
  };
  return { data, api: createSecureStorage(driver, () => `generation-${++generation}`), reject: (fn) => { reject = fn; } };
}

test('large Unicode sessions survive a cold adapter restart without plaintext fallback', async () => {
  const store = storage();
  const session = JSON.stringify({ refresh_token: 'fixture-only', name: '🏓菲律宾'.repeat(1400) });
  await store.api.setItem('session', session);
  assert.equal(await store.api.getItem('session'), session);
  const restarted = createSecureStorage({
    getItem: async (key) => store.data.get(key) ?? null,
    setItem: async () => {}, removeItem: async () => {},
  }, () => 'unused');
  assert.equal(await restarted.getItem('session'), session);
});

test('failed replacement or manifest commit preserves the previous complete session', async () => {
  for (const fail of [(key) => key.endsWith('generation-2.1'), (key) => key === 'session']) {
    const store = storage();
    await store.api.setItem('session', 'previous-session');
    store.reject(fail);
    await assert.rejects(store.api.setItem('session', 'x'.repeat(2000)), /Device storage/);
    assert.equal(await store.api.getItem('session'), 'previous-session');
    assert.equal(store.data.size, 2);
  }
});

test('concurrent replacements serialize and sign-out removes all referenced chunks', async () => {
  const store = storage();
  await Promise.all([store.api.setItem('session', 'a'.repeat(9000)), store.api.setItem('session', 'b'.repeat(1100))]);
  assert.equal(await store.api.getItem('session'), 'b'.repeat(1100));
  assert.equal(store.data.size, 4);
  await store.api.removeItem('session');
  assert.equal(await store.api.getItem('session'), null);
  assert.equal(store.data.size, 0);
});

test('corrupt or incomplete persistence fails closed and can be cleared', async () => {
  const store = storage();
  store.data.set('session', '{not-json');
  await assert.rejects(store.api.getItem('session'));
  await store.api.removeItem('session');
  await store.api.setItem('session', 'x'.repeat(1100));
  const entry = JSON.parse(store.data.get('session'));
  store.data.delete(`session.${entry.generation}.1`);
  await assert.rejects(store.api.getItem('session'), /incomplete/);
  await store.api.removeItem('session');
  assert.equal(store.data.size, 0);
});
