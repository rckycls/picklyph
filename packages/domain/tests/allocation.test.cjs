const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readAllocationBlock, readAllocationRangeQuery, allocationsOverlap, isLiveAllocation, holdUntil } = require('../src/allocation.ts');

const court = 'A3000000-0000-4000-8000-000000000001';
const request = '74000000-0000-4000-8000-000000000001';
const block = (starts_at, ends_at, extra = {}) => ({ court_id: court, request_id: request, starts_at, ends_at, ...extra });

test('block commands normalize explicit offsets and mirror SQL alignment/length rules', () => {
  assert.deepEqual(readAllocationBlock(block('2026-10-09T08:00:00+08:00', '2026-10-09T09:30:00+08:00')),
    { court_id: court.toLowerCase(), request_id: request, starts_at: '2026-10-09T00:00:00.000Z', ends_at: '2026-10-09T01:30:00.000Z' });
  assert.equal(readAllocationBlock(block('2026-10-09T23:00:00+08:00', '2026-10-10T23:00:00+08:00')).ends_at, '2026-10-10T15:00:00.000Z');
  for (const bad of [
    block('2026-10-09T08:15:00+08:00', '2026-10-09T09:00:00+08:00'), block('2026-10-09T08:00:01Z', '2026-10-09T09:00:00Z'),
    block('2026-10-09T08:00:00Z', '2026-10-09T08:00:00Z'), block('2026-10-09T09:00:00Z', '2026-10-09T08:00:00Z'),
    block('2026-10-09T08:00:00Z', '2026-10-10T08:30:00Z'), block('2026-10-09T08:00:00', '2026-10-09T09:00:00'),
    block('2026-02-30T08:00:00Z', '2026-02-30T09:00:00Z'), block('2100-01-01T00:00:00Z', '2100-01-01T01:00:00Z'),
    block('2026-10-09T08:00:00Z', '2026-10-09T09:00:00Z', { actor_user_id: request }), { ...block('2026-10-09T08:00:00Z', '2026-10-09T09:00:00Z'), court_id: 'court-a' },
    null, [],
  ]) assert.throws(() => readAllocationBlock(bad), { name: 'AllocationInputError' });
});
test('range queries are bounded to 31 days and strictly ordered', () => {
  assert.deepEqual(readAllocationRangeQuery({ venue_id: request, range_start: '2026-10-01T00:00:00+08:00', range_end: '2026-11-01T00:00:00+08:00' }),
    { venue_id: request, range_start: '2026-09-30T16:00:00.000Z', range_end: '2026-10-31T16:00:00.000Z' });
  for (const [a, b] of [['2026-10-01T00:00:00Z', '2026-11-01T00:00:01Z'], ['2026-10-02T00:00:00Z', '2026-10-01T00:00:00Z'], ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z']])
    assert.throws(() => readAllocationRangeQuery({ venue_id: request, range_start: a, range_end: b }), { name: 'AllocationInputError' });
});
test('half-open overlap compares instants, not spellings', () => {
  const a = { starts_at: '2026-10-09T08:00:00+08:00', ends_at: '2026-10-09T09:00:00+08:00' };
  assert.equal(allocationsOverlap(a, { starts_at: '2026-10-09T01:00:00Z', ends_at: '2026-10-09T02:00:00Z' }), false);
  assert.equal(allocationsOverlap({ starts_at: '2026-10-08T23:00:00Z', ends_at: '2026-10-09T00:00:00Z' }, a), false);
  assert.equal(allocationsOverlap(a, { starts_at: '2026-10-09T00:30:00Z', ends_at: '2026-10-09T01:30:00Z' }), true);
  assert.equal(allocationsOverlap(a, { starts_at: '2026-10-08T00:00:00Z', ends_at: '2026-10-10T00:00:00Z' }), true);
});
test('an elapsed hold is no longer live at its exact expiry; released rows never are', () => {
  const hold = { state: 'active', expires_at: '2026-10-09T00:15:00Z' };
  assert.equal(isLiveAllocation(hold, '2026-10-09T00:14:59.999Z'), true);
  assert.equal(isLiveAllocation(hold, '2026-10-09T08:15:00+08:00'), false);
  assert.equal(isLiveAllocation({ state: 'active', expires_at: null }, '2099-01-01T00:00:00Z'), true);
  assert.equal(isLiveAllocation({ state: 'released', expires_at: null }, '2026-10-09T00:00:00Z'), false);
  assert.equal(isLiveAllocation({ state: 'expired', expires_at: '2026-10-10T00:00:00Z' }, '2026-10-09T00:00:00Z'), false);
});
test('hold expiry uses the server clock, is capped at start and never exceeds 2 hours', () => {
  assert.equal(holdUntil('2026-10-09T00:00:00Z', '2026-10-09T08:00:00Z', 15), '2026-10-09T00:15:00.000Z');
  assert.equal(holdUntil('2026-10-09T00:00:00Z', '2026-10-09T01:00:00Z', 120), '2026-10-09T01:00:00.000Z');
  for (const [at, start, minutes] of [['2026-10-09T00:00:00Z', '2026-10-09T08:00:00Z', 121], ['2026-10-09T00:00:00Z', '2026-10-09T08:00:00Z', 0],
    ['2026-10-09T00:00:00Z', '2026-10-09T08:00:00Z', 1.5], ['2026-10-09T01:00:00Z', '2026-10-09T01:00:00Z', 15]])
    assert.throws(() => holdUntil(at, start, minutes), { name: 'AllocationInputError' });
});
