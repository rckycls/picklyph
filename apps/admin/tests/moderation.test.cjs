const assert = require('node:assert/strict');
const { test } = require('node:test');
const { moderationRejection, MODERATION_ACTION_LABELS } = require('../src/lib/moderation.ts');

test('moderation refusals map to reviewer messages; unexpected errors stay unavailable', () => {
  assert.equal(moderationRejection({ hint: 'self_moderation', code: '42501' }).status, 403);
  assert.equal(moderationRejection({ hint: 'moderator_required', code: '42501' }).status, 403);
  assert.equal(moderationRejection({ hint: 'already_decided', code: '23505' }).status, 409);
  assert.match(moderationRejection({ hint: 'not_published', code: '55000' }).message, /directory/);
  assert.match(moderationRejection({ hint: 'not_moderation_suspension', code: '55000' }).message, /administrator/);
  assert.match(moderationRejection({ hint: 'active_court_required', code: '22023' }).message, /active court/);
  assert.equal(moderationRejection({ hint: 'not_found', code: 'P0002' }).status, 404);
  assert.equal(moderationRejection({ hint: 'invalid_input', code: '22023' }).status, 400);
  assert.equal(moderationRejection({ code: '42501' }).status, 403);
  assert.equal(moderationRejection({ code: '22P02' }).status, 400);
  for (const error of [{ code: '40001' }, { code: 'PGRST301' }, { code: '42883', hint: null }, {}]) assert.equal(moderationRejection(error), null);
});

test('every audited moderation action has a console label', () => {
  assert.deepEqual(Object.keys(MODERATION_ACTION_LABELS).sort(),
    ['owner.revoke', 'report.dismiss', 'report.resolve', 'report.submit', 'venue.reinstate', 'venue.suspend']);
});
