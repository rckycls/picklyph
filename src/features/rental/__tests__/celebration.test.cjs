const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { load, booking } = require('./helpers.cjs');
const { createCelebrations } = load(path.join(path.dirname(module.filename), '../celebration.ts'));

test('fresh confirmation of a new reservation celebrates once through refreshes and recovery retries', () => {
  const store = createCelebrations(); const b = booking();
  store.requested('player-a', b); assert.equal(store.observe('player-a', b, false), false);
  assert.equal(store.observe('player-a', b, true), true);
  assert.equal(store.observe('player-a', b, true), false);
  store.requested('player-a', b); assert.equal(store.observe('player-a', b, true), false);
});

test('pending requests cheer only after a fresh server transition to confirmed', () => {
  const store = createCelebrations(); const pending = booking('pending');
  assert.equal(store.observe('player-a', pending, true), false);
  assert.equal(store.observe('player-a', booking('confirmed'), false), false);
  assert.equal(store.observe('player-a', booking('confirmed'), true), true);
  assert.equal(store.observe('player-a', booking('confirmed'), true), false);
});

test('old confirmations and ended bookings do not celebrate; account and session state is isolated', () => {
  const store = createCelebrations(); const confirmed = booking();
  assert.equal(store.observe('player-a', confirmed, true), false);
  store.requested('player-a', confirmed);
  assert.equal(store.observe('player-b', confirmed, true), false);
  assert.equal(store.observe('player-a', confirmed, true), true);
  assert.equal(createCelebrations().observe('player-a', confirmed, true), false);
  for (const status of ['cancelled', 'declined', 'expired']) {
    const s = createCelebrations(); s.requested('player-a', booking('pending'));
    assert.equal(s.observe('player-a', booking(status), true), false);
    assert.equal(s.observe('player-a', confirmed, true), false);
  }
});
