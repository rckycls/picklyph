const assert = require('node:assert/strict');
const { test } = require('node:test');
const { toDisplayInstant, reviewRejection, isSameOriginFetch, evidenceHeaders } = require('../src/lib/ownership.ts');
const { formatManilaDateTime } = require('../../../packages/domain/src/booking.ts');

test('database timestamps with microseconds become displayable Manila times', () => {
  assert.equal(toDisplayInstant('2026-10-07T02:30:12.123456+00:00'), '2026-10-07T02:30:12.123+00:00');
  assert.equal(toDisplayInstant('2026-10-07T02:30:12.12345Z'), '2026-10-07T02:30:12.123Z');
  for (const value of ['2026-10-07T02:30:12+00:00', '2026-10-07T02:30:12.5+08:00', '2026-10-07T02:30:12.123Z']) assert.equal(toDisplayInstant(value), value);
  assert.match(formatManilaDateTime(toDisplayInstant('2026-10-07T02:30:12.123456+00:00')), /10:30/);
});

test('database rejections map to reviewer messages; unexpected errors stay unavailable', () => {
  assert.equal(reviewRejection({ hint: 'self_review', code: '42501' }).status, 403);
  assert.match(reviewRejection({ hint: 'admin_required', code: '42501' }).message, /administrators/i);
  assert.equal(reviewRejection({ hint: 'already_decided', code: '23505' }).status, 409);
  assert.equal(reviewRejection({ hint: 'listing_unavailable', code: 'P0002' }).status, 409);
  assert.equal(reviewRejection({ hint: 'not_found', code: 'P0002' }).status, 404);
  assert.equal(reviewRejection({ code: '42501' }).status, 403);
  assert.equal(reviewRejection({ code: '22023' }).status, 400);
  assert.equal(reviewRejection({ code: '57014' }), null);
  assert.equal(reviewRejection({ hint: 'made_up', code: 'XX000' }), null);
});

test('evidence is same-origin only and never cacheable or executable', () => {
  const request = (site) => new Request('https://console.example.invalid/api/console/ownership/evidence/x', { headers: site ? { 'sec-fetch-site': site } : {} });
  assert.ok(isSameOriginFetch(request(null)) && isSameOriginFetch(request('same-origin')) && isSameOriginFetch(request('none')));
  assert.ok(!isSameOriginFetch(request('cross-site')) && !isSameOriginFetch(request('same-site')));
  const headers = evidenceHeaders('image/png');
  assert.equal(headers['Content-Type'], 'image/png');
  assert.match(headers['Cache-Control'], /no-store/);
  assert.match(headers['Content-Security-Policy'], /sandbox/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
});
