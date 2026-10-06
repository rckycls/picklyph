const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readOwnerSubmission, readOwnerLookup, readOwnerNote, sniffEvidence, OwnerInputError } = require('../src/owner.ts');

const requestId = 'A4000000-0000-4000-8000-000000000001';
const venue = { name: '  Corner   Courts ', address_line: '12 Fixture St', city: 'Manila', province: 'Metro Manila', latitude: 14.6, longitude: 121, court_count: 3 };
const json = (value) => JSON.stringify(value);

test('owner submissions normalize text/IDs and keep only the documented fields', () => {
  const claim = readOwnerSubmission(json({ kind: 'claim', request_id: requestId, venue_id: 'B4000000-0000-4000-8000-000000000001', note: '  I manage it.\r\nCall me. ' }));
  assert.deepEqual(claim, { kind: 'claim', request_id: requestId.toLowerCase(), venue_id: 'b4000000-0000-4000-8000-000000000001', note: 'I manage it.\nCall me.' });
  const pin = readOwnerSubmission(json({ kind: 'venue', request_id: requestId, venue, note: '   ', acknowledge_duplicates: false }));
  assert.equal(pin.venue.name, 'Corner Courts'); assert.equal(pin.note, null); assert.equal(pin.venue.court_count, 3);
});

test('authority fields, bad pins, court counts, oversize and malformed input are rejected', () => {
  const bad = [
    'not json', '[]', json({ kind: 'claim', request_id: 'x', venue_id: requestId, note: null }),
    json({ kind: 'claim', request_id: requestId, venue_id: requestId, note: null, actor_user_id: requestId }),
    json({ kind: 'claim', request_id: requestId, venue_id: requestId, note: null, status: 'approved' }),
    json({ kind: 'venue', request_id: requestId, venue, note: null }),
    json({ kind: 'venue', request_id: requestId, venue, note: null, acknowledge_duplicates: 'yes' }),
    json({ kind: 'venue', request_id: requestId, venue: { ...venue, publication_status: 'approved' }, note: null, acknowledge_duplicates: true }),
    json({ kind: 'venue', request_id: requestId, venue: { ...venue, latitude: 35.6, longitude: 139.7 }, note: null, acknowledge_duplicates: true }),
    json({ kind: 'venue', request_id: requestId, venue: { ...venue, latitude: '14.6' }, note: null, acknowledge_duplicates: true }),
    json({ kind: 'venue', request_id: requestId, venue: { ...venue, court_count: 0 }, note: null, acknowledge_duplicates: true }),
    json({ kind: 'venue', request_id: requestId, venue: { ...venue, court_count: 41 }, note: null, acknowledge_duplicates: true }),
    json({ kind: 'venue', request_id: requestId, venue: { ...venue, court_count: 2.5 }, note: null, acknowledge_duplicates: true }),
    json({ kind: 'venue', request_id: requestId, venue: { ...venue, name: 'x'.repeat(121) }, note: null, acknowledge_duplicates: true }),
    json({ kind: 'venue', request_id: requestId, venue: { ...venue, city: '\u0000' }, note: null, acknowledge_duplicates: true }),
    json({ kind: 'claim', request_id: requestId, venue_id: requestId, note: 'x'.repeat(501) }),
    json({ kind: 'claim', request_id: requestId, venue_id: requestId, note: 'tab\there' }),
    json({ kind: 'admin', request_id: requestId }), 'x'.repeat(4097),
  ];
  for (const input of bad) assert.throws(() => readOwnerSubmission(input), OwnerInputError, input.slice(0, 80));
  assert.equal(readOwnerNote(null), null);
});

test('evidence type comes from leading bytes only', () => {
  assert.equal(sniffEvidence(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])), 'image/jpeg');
  assert.equal(sniffEvidence(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  for (const bytes of [[], [0xff, 0xd8], [0x25, 0x50, 0x44, 0x46], [0x47, 0x49, 0x46, 0x38], [0x3c, 0x73, 0x76, 0x67]]) {
    assert.equal(sniffEvidence(new Uint8Array(bytes)), null);
  }
});

test('lookups accept one address or a Philippine pin, nothing else', () => {
  assert.deepEqual(readOwnerLookup(new URLSearchParams('address=%20 12  Fixture St ')), { kind: 'address', address: '12 Fixture St' });
  assert.deepEqual(readOwnerLookup(new URLSearchParams('latitude=14.6&longitude=121.0001&name=Corner')), { kind: 'nearby', latitude: 14.6, longitude: 121.0001, name: 'Corner' });
  assert.equal(readOwnerLookup(new URLSearchParams('latitude=14.6&longitude=121')).name, null);
  for (const query of ['', 'address=ab', `address=${'x'.repeat(201)}`, 'address=a&address=b', 'address=Manila&latitude=14',
    'latitude=35.6&longitude=139.7', 'latitude=1e1&longitude=121', 'latitude=14.6', 'latitude=14.6&longitude=121&actor=x',
    'latitude=14.6&longitude=121&name=', 'address=%00abc']) {
    assert.throws(() => readOwnerLookup(new URLSearchParams(query)), OwnerInputError, query);
  }
});
