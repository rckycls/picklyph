const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { hashClaimCode, normalizeClaimCode, CLAIM_CODE_MAX_FAILURES, CLAIM_CODE_LOCKOUT_MINUTES } = require('../src/claimCode.ts');
const prelaunch = require('../src/prelaunch.ts');
const { readOwnerSubmission, readRegistrationCheck, readClaimCode, ClaimCodeInputError, OwnerInputError, MAX_CODE_CHECK_BYTES } = require('../src/owner.ts');

const requestId = 'A4000000-0000-4000-8000-000000000001';
const json = (value) => JSON.stringify(value);

test('one claim-code HMAC for the registration server and the app redemption (T53/T54)', async () => {
  const secret = 's'.repeat(32);
  const expected = crypto.createHmac('sha256', secret).update('pickly-claim-code:v1:ABCDEFGHJK').digest('hex');
  assert.equal(await hashClaimCode(secret, 'ABCDEFGHJK'), expected, 'matches the T53 format (and the Docker harness)');
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.notEqual(await hashClaimCode('t'.repeat(32), 'ABCDEFGHJK'), expected);
  assert.equal(prelaunch.normalizeClaimCode, normalizeClaimCode, 'prelaunch re-exports the same helpers');
  assert.equal(prelaunch.CLAIM_CODE_LENGTH, 10);
  assert.deepEqual([CLAIM_CODE_MAX_FAILURES, CLAIM_CODE_LOCKOUT_MINUTES], [5, 60], 'the numbers the migration enforces');
});

test('code redemptions and checks read canonical codes; anything else is refused before the database', () => {
  assert.deepEqual(readOwnerSubmission(json({ kind: 'registration', request_id: requestId, code: ' abcde-fghjk ', note: '  Owner of the hall. ' })),
    { kind: 'registration', request_id: requestId.toLowerCase(), code: 'ABCDEFGHJK', note: 'Owner of the hall.' });
  assert.equal(readRegistrationCheck(json({ code: 'abcde fghjk' })), 'ABCDEFGHJK');
  assert.equal(readClaimCode('ABCDE-FGHJK'), 'ABCDEFGHJK');
  for (const code of ['ABCDE-FGHJ0', 'ABCDE-FGHJ', 'ABCDE-FGHJKL', 12, null, '']) {
    assert.throws(() => readRegistrationCheck(json({ code })), ClaimCodeInputError, String(code));
    assert.throws(() => readOwnerSubmission(json({ kind: 'registration', request_id: requestId, code, note: null })), ClaimCodeInputError);
  }
  for (const input of [json({ code: 'ABCDEFGHJK', extra: 1 }), json({}), json(['ABCDEFGHJK']), 'not json', json({ code: 'A'.repeat(MAX_CODE_CHECK_BYTES) })]) {
    assert.throws(() => readRegistrationCheck(input), (error) => error instanceof OwnerInputError && !(error instanceof ClaimCodeInputError), input.slice(0, 40));
  }
  for (const body of [{ kind: 'registration', request_id: requestId, code: 'ABCDEFGHJK' }, { kind: 'registration', request_id: requestId, code: 'ABCDEFGHJK', note: null, venue_id: requestId },
    { kind: 'registration', request_id: 'x', code: 'ABCDEFGHJK', note: null }, { kind: 'registration', request_id: requestId, code: 'ABCDEFGHJK', note: 'x'.repeat(501) }]) {
    assert.throws(() => readOwnerSubmission(json(body)), OwnerInputError);
  }
});
