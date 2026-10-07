const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readOwnershipDecision, readReviewCursor, formatReviewCursor, ReviewInputError } = require('../src/review.ts');

const id = 'C5000000-0000-4000-8000-000000000001';
const venue = 'D5000000-0000-4000-8000-000000000002';
const body = (patch) => ({ subject_id: id, decision: 'approve', target_venue_id: null, rejection_reason: null, ...patch });

test('review decisions keep exactly the documented shape and normalize IDs', () => {
  assert.deepEqual(readOwnershipDecision(body({})), { subject_id: id.toLowerCase(), decision: 'approve', target_venue_id: null, rejection_reason: null });
  assert.deepEqual(readOwnershipDecision(body({ decision: 'merge', target_venue_id: venue })).target_venue_id, venue.toLowerCase());
  assert.equal(readOwnershipDecision(body({ decision: 'reject', rejection_reason: 'duplicate' })).rejection_reason, 'duplicate');
});

test('actor fields, mismatched targets/reasons and unknown decisions are rejected', () => {
  for (const input of [null, [], 'approve', body({ actor_user_id: id }), { subject_id: id, decision: 'approve' },
    body({ subject_id: 'x' }), body({ decision: 'publish' }), body({ decision: 'approve_new' }), body({ decision: 'approve', rejection_reason: 'other' }),
    body({ decision: 'approve', target_venue_id: venue }), body({ decision: 'merge' }), body({ decision: 'merge', target_venue_id: 'x' }),
    body({ decision: 'merge', target_venue_id: venue, rejection_reason: 'other' }), body({ decision: 'reject' }),
    body({ decision: 'reject', rejection_reason: 'rude' }), body({ decision: 'reject', rejection_reason: 'other', target_venue_id: venue })]) {
    assert.throws(() => readOwnershipDecision(input), ReviewInputError, JSON.stringify(input));
  }
});

test('queue cursors round-trip database timestamps and reject anything else', () => {
  const cursor = { created_at: '2026-10-07T09:15:02.123456+00:00', id: '53000000-0000-4000-8000-000000000001' };
  assert.deepEqual(readReviewCursor(formatReviewCursor(cursor)), cursor);
  assert.equal(readReviewCursor(undefined), null);
  assert.equal(readReviewCursor(''), null);
  for (const bad of ['x', `${cursor.created_at}`, `2026-13-45T00:00:00Z~${cursor.id}`, `${cursor.created_at}~nope`, `${cursor.created_at}~${cursor.id}~x`]) {
    assert.throws(() => readReviewCursor(bad), ReviewInputError, bad);
  }
});
