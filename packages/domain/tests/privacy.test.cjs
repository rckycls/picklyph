const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readAccountDeletionRequest, PrivacyInputError, ACCOUNT_DELETION_CONFIRMATION, MAX_ACCOUNT_DELETION_BYTES } = require('../src/privacy.ts');

test('account deletion needs exactly the confirmation body and never carries an actor', () => {
  assert.deepEqual(readAccountDeletionRequest({ confirm: 'delete_account' }), { confirm: ACCOUNT_DELETION_CONFIRMATION });
  for (const input of [null, undefined, [], 'delete_account', {}, { confirm: 'DELETE' }, { confirm: 'delete_account ' }, { confirm: true },
    { confirm: 'delete_account', actor_user_id: 'c4790000-0000-4000-8000-000000000001' }, { confirm: 'delete_account', user_id: 'x' }, { delete: true }]) {
    assert.throws(() => readAccountDeletionRequest(input), PrivacyInputError, JSON.stringify(input));
  }
  assert.ok(new TextEncoder().encode(JSON.stringify({ confirm: ACCOUNT_DELETION_CONFIRMATION })).byteLength < MAX_ACCOUNT_DELETION_BYTES);
});
