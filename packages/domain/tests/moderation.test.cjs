const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readVenueReport, readReportDetails, readModerationDecision, readOwnershipRevocation, ModerationInputError, MAX_REPORT_BYTES } = require('../src/moderation.ts');

const key = 'C4650000-0000-4000-8000-000000000001';
const venue = 'C4620000-0000-4000-8000-000000000001';
const report = (patch) => ({ request_id: key, venue_id: venue, reason: 'wrong_details', details: null, ...patch });

test('report details are typed text: line breaks normalized, trimmed, empty means none', () => {
  assert.equal(readReportDetails('  Hours changed\r\nin June \r'), 'Hours changed\nin June');
  assert.equal(readReportDetails(' \n '), null);
  assert.equal(readReportDetails('é'.repeat(500)), 'é'.repeat(500));
  for (const bad of ['x'.repeat(501), 'tab\there', 'bell\u0007', 'c1\u0085', `line${String.fromCharCode(0x2028)}sep`]) {
    assert.throws(() => readReportDetails(bad), ModerationInputError, JSON.stringify(bad));
  }
});

test('report bodies keep exactly the documented shape, normalize IDs and need canonical details', () => {
  assert.deepEqual(readVenueReport(report({})), { request_id: key.toLowerCase(), venue_id: venue.toLowerCase(), reason: 'wrong_details', details: null });
  assert.equal(readVenueReport(report({ details: 'Line one\nline two' })).details, 'Line one\nline two');
  for (const input of [null, [], 'report', report({ actor_user_id: key }), { request_id: key, venue_id: venue, reason: 'closed' },
    report({ reason: 'rude' }), report({ reason: null }), report({ request_id: 'x' }), report({ venue_id: 7 }), report({ details: '' }),
    report({ details: ' padded' }), report({ details: 'crlf\r\nline' }), report({ details: 'x'.repeat(501) }), report({ details: 5 })]) {
    assert.throws(() => readVenueReport(input), ModerationInputError, JSON.stringify(input));
  }
  const largest = JSON.stringify(report({ details: '\u{1F3D3}'.repeat(500) }));
  assert.ok(new TextEncoder().encode(largest).byteLength < MAX_REPORT_BYTES, 'largest body fits the byte cap');
});

test('decisions mirror the database rules and reject any actor field', () => {
  const ids = ['C4670000-0000-4000-8000-000000000001', 'c4670000-0000-4000-8000-000000000002'];
  const body = (patch) => ({ venue_id: venue, decision: 'dismiss', reason: null, report_ids: ids, ...patch });
  assert.deepEqual(readModerationDecision(body({})).report_ids, ids.map((id) => id.toLowerCase()));
  assert.equal(readModerationDecision(body({ decision: 'resolve' })).decision, 'resolve');
  assert.deepEqual(readModerationDecision(body({ decision: 'suspend', reason: 'unsafe', report_ids: [] })).report_ids, []);
  assert.equal(readModerationDecision(body({ decision: 'reinstate', report_ids: [] })).decision, 'reinstate');
  for (const input of [body({ actor_user_id: venue }), body({ decision: 'ban' }), body({ report_ids: [] }), body({ reason: 'unsafe' }),
    body({ decision: 'suspend' }), body({ decision: 'suspend', reason: 'rude' }), body({ decision: 'reinstate' }),
    body({ decision: 'reinstate', reason: 'unsafe', report_ids: [] }), body({ report_ids: [ids[0], ids[0].toLowerCase()] }),
    body({ report_ids: ['x'] }), body({ report_ids: Array.from({ length: 101 }, (_, n) => `c4670000-0000-4000-8000-${String(n).padStart(12, '0')}`) }),
    body({ venue_id: 'x' }), { venue_id: venue, decision: 'dismiss', report_ids: ids }]) {
    assert.throws(() => readModerationDecision(input), ModerationInputError, JSON.stringify(input).slice(0, 120));
  }
});

test('revocations need a listing, an account and a fixed reason', () => {
  assert.deepEqual(readOwnershipRevocation({ venue_id: venue, owner_user_id: key, reason: 'not_owner' }),
    { venue_id: venue.toLowerCase(), owner_user_id: key.toLowerCase(), reason: 'not_owner' });
  for (const input of [{ venue_id: venue, owner_user_id: key, reason: 'rude' }, { venue_id: venue, owner_user_id: key },
    { venue_id: venue, owner_user_id: key, reason: 'other', enabled: false }, { venue_id: venue, owner_user_id: null, reason: 'other' }]) {
    assert.throws(() => readOwnershipRevocation(input), ModerationInputError);
  }
});
