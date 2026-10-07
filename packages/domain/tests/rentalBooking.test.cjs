const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readRentalCommand, readRentalQuery } = require('../src/rentalBooking.ts');
const id = 'b1000000-0000-4000-8000-000000000001';
const request = { kind: 'request', court_id: id, request_id: id, starts_at: '2026-10-09T08:00:00+08:00', ends_at: '2026-10-09T09:30:00+08:00',
  expected_quote: { total_centavos: 30000, schedule_revision: '2', court_hours_revision: null, policy_revision: '0' } };
test('rental commands normalize UTC and reject client authority/unsafe review amounts', () => {
  assert.equal(readRentalCommand(request).starts_at, '2026-10-09T00:00:00.000Z');
  for (const kind of ['accept','decline','cancel','expire']) assert.deepEqual(readRentalCommand({ kind, booking_id: id }), { kind, booking_id: id });
  for (const body of [{ ...request, actor_user_id: id }, { ...request, payment: 'online' }, { ...request, policy: {} },
    { ...request, ends_at: '2026-10-09T08:30:00+08:00' }, { ...request, starts_at: '2026-10-09T08:15:00+08:00' },
    { ...request, expected_quote: { ...request.expected_quote, total_centavos: 0.5 } },
    { ...request, expected_quote: { ...request.expected_quote, policy_revision: 1 } },
    { ...request, expected_quote: { ...request.expected_quote, schedule_revision: '01' } },
    { ...request, expected_quote: { ...request.expected_quote, total_centavos: Number.MAX_SAFE_INTEGER + 1 } },
    { kind: 'accept', booking_id: id, actor_user_id: id }, { kind: 'pay', booking_id: id }]) assert.throws(() => readRentalCommand(body));
});
test('rental query contracts bound reads to self history, owner requests, detail or one rental quote', () => {
  const query = text => readRentalQuery(new URLSearchParams(text));
  assert.deepEqual(query('section=history'), { section: 'history', after_id: null });
  assert.deepEqual(query('section=requests&venue_id=' + id + '&after_id=' + id), { section: 'requests', venue_id: id, after_id: id });
  assert.deepEqual(query('section=booking&booking_id=' + id), { section: 'booking', booking_id: id });
  for (const text of ['section=history&actor_user_id=' + id, 'section=history&section=history', 'section=history&limit=999',
    'section=requests', 'section=booking&booking_id=nope', 'section=history&after_id=', 'section=quote&court_id=' + id]) assert.throws(() => query(text));
});
