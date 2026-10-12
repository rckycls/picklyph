const assert = require('node:assert/strict');
const { test } = require('node:test');
const { bulkOutcome, bulkFailureMessage } = require('../src/lib/directory-bulk.ts');
const id = 'a1000000-0000-4000-8000-000000000001';

test('bulk outcomes: done, a repeated delete, and a reason for every skipped listing', () => {
  assert.deepEqual(bulkOutcome('publish', id, null), { id, done: true, message: null });
  assert.deepEqual(bulkOutcome('delete', id, { code: 'P0002' }), { id, done: true, message: 'Already deleted.' });
  assert.deepEqual(bulkOutcome('publish', id, { code: 'P0002' }), { id, done: false, message: 'This listing no longer exists.' });
  assert.match(bulkFailureMessage('delete', { code: '55006', hint: 'listing_published' }), /Move it to draft or suspend it first/);
  for (const [detail, words] of [['court_history', 'court bookings or blocks'], ['session_history', 'open-play sessions'], ['owner', 'an owner'],
    ['claim', 'an ownership claim'], ['submission', 'an owner submission'], ['photos', 'photos'], ['reports', 'reports or moderation history'],
    ['merchant', 'payment settings'], ['cancellations', 'venue cancellations'], ['unknown', 'history']]) {
    assert.equal(bulkFailureMessage('delete', { code: '55006', hint: 'listing_in_use', details: detail }), `It has ${words}, so it can’t be deleted. Suspend it instead.`);
  }
  assert.match(bulkFailureMessage('draft', { code: '40001' }), /changed\. Reload/);
  assert.match(bulkFailureMessage('suspend', { code: '42501' }), /Administrator access/);
  assert.equal(bulkFailureMessage('publish', { code: '22023' }), 'Add an active court before publishing.');
  assert.equal(bulkFailureMessage('draft', { code: '22023' }), 'Check the listing details.');
  assert.match(bulkFailureMessage('delete', { code: 'PGRST202' }), /latest database update/);
  assert.match(bulkFailureMessage('delete', { code: '08006' }), /Unavailable right now/);
  assert.equal(bulkFailureMessage('delete', { hint: 'toString' }), 'Unavailable right now. Try again.');
});
