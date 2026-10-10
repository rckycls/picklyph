const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readAccountDeletionRequest, PrivacyInputError, ACCOUNT_DELETION_CONFIRMATION, MAX_ACCOUNT_DELETION_BYTES, APPLE_DELETION_REJECTIONS } = require('../src/privacy.ts');

test('account deletion needs exactly the confirmation body and never carries an actor', () => {
  assert.deepEqual(readAccountDeletionRequest({ confirm: 'delete_account' }), { confirm: ACCOUNT_DELETION_CONFIRMATION });
  for (const input of [null, undefined, [], 'delete_account', {}, { confirm: 'DELETE' }, { confirm: 'delete_account ' }, { confirm: true },
    { confirm: 'delete_account', actor_user_id: 'c4790000-0000-4000-8000-000000000001' }, { confirm: 'delete_account', user_id: 'x' }, { delete: true }]) {
    assert.throws(() => readAccountDeletionRequest(input), PrivacyInputError, JSON.stringify(input));
  }
  assert.ok(new TextEncoder().encode(JSON.stringify({ confirm: ACCOUNT_DELETION_CONFIRMATION })).byteLength < MAX_ACCOUNT_DELETION_BYTES);
});

test('T50a: an optional, bounded Apple authorization code rides with the confirmation, and nothing else does', () => {
  const code = 'c1f2e3d4a5b6c7d8e9f0a1b2c3d4e5f6a.0.srst.Kx9_mQ-2vZ';
  assert.deepEqual(readAccountDeletionRequest({ apple_authorization_code: code, confirm: 'delete_account' }),
    { confirm: ACCOUNT_DELETION_CONFIRMATION, apple_authorization_code: code });
  for (const bad of ['', 'short', 'has space inside the code', 'tab\tinside-the-code', 'line\nbreak-in-code', 'é-not-ascii-code', 'x'.repeat(1025), 42, null, ['abcdefghij']]) {
    assert.throws(() => readAccountDeletionRequest({ confirm: 'delete_account', apple_authorization_code: bad }), PrivacyInputError, JSON.stringify(bad));
  }
  assert.throws(() => readAccountDeletionRequest({ apple_authorization_code: code }), PrivacyInputError, 'the confirmation is still required');
  assert.throws(() => readAccountDeletionRequest({ confirm: 'delete_account', apple_authorization_code: code, actor_user_id: 'x' }), PrivacyInputError);
  assert.throws(() => readAccountDeletionRequest({ confirm: 'delete_account', apple_identity: 'x' }), PrivacyInputError, 'no Apple identity from the body');
  const largest = JSON.stringify({ confirm: ACCOUNT_DELETION_CONFIRMATION, apple_authorization_code: '~'.repeat(1024) });
  assert.ok(new TextEncoder().encode(largest).byteLength < MAX_ACCOUNT_DELETION_BYTES, 'the largest valid body fits the cap');
  assert.deepEqual([...APPLE_DELETION_REJECTIONS], ['apple_reauthorization_required', 'apple_account_mismatch']);
});
