const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  readOwnerVenueCommand, readOwnerPhotoAdd, readOwnerVenueQuery, photoDimensionsAllowed, VenueInputError,
} = require('../src/ownerVenues.ts');

const VENUE = 'B5000000-0000-4000-8000-000000000001';
const COURT = 'C5000000-0000-4000-8000-000000000001';
const VERSION = '2026-10-07T01:02:03.456789+00:00';
const court = (overrides = {}) => ({ id: COURT, name: 'Court 1', surface: 'hard', is_indoor: false, is_covered: true, status: 'active', ...overrides });
const save = (overrides = {}) => JSON.stringify({ kind: 'save', venue_id: VENUE, expected_updated_at: VERSION,
  venue: { name: '  Alpha   Courts ', address_line: '1 Rizal Ave', city: 'Manila', province: 'Metro Manila' }, courts: [court()], ...overrides });

test('owner saves normalize text and IDs and keep the exact microsecond version', () => {
  const command = readOwnerVenueCommand(save({ courts: [court(), court({ id: null, name: ' Court  2 ', surface: null, status: 'inactive' })] }));
  assert.deepEqual(command, { kind: 'save', venue_id: VENUE.toLowerCase(), expected_updated_at: VERSION,
    venue: { name: 'Alpha Courts', address_line: '1 Rizal Ave', city: 'Manila', province: 'Metro Manila' },
    courts: [{ ...court(), id: COURT.toLowerCase() }, { id: null, name: 'Court 2', surface: null, is_indoor: false, is_covered: true, status: 'inactive' }] });
  assert.deepEqual(readOwnerVenueCommand(JSON.stringify({ kind: 'remove_photo', venue_id: VENUE, photo_id: COURT })),
    { kind: 'remove_photo', venue_id: VENUE.toLowerCase(), photo_id: COURT.toLowerCase() });
});

test('pins, statuses, authority fields and malformed owner input are rejected', () => {
  const details = { name: 'A', address_line: 'B', city: 'C', province: 'D' };
  for (const body of [
    'not json', '[]', JSON.stringify({ kind: 'publish', venue_id: VENUE }),
    save({ venue: { ...details, latitude: 14.6, longitude: 121 } }),
    save({ venue: { ...details, publication_status: 'approved' } }),
    save({ venue: { ...details, claim_status: 'verified' } }),
    save({ actor_user_id: VENUE }),
    save({ venue: { ...details, name: '   ' } }),
    save({ venue: { ...details, name: 'Bell\u0007' } }),
    save({ venue: { ...details, name: 'x'.repeat(121) } }),
    save({ expected_updated_at: null }), save({ expected_updated_at: '2026-10-07' }), save({ expected_updated_at: '2026-02-30T00:00:00Z' }),
    save({ venue_id: 'not-a-uuid' }),
    save({ courts: {} }), save({ courts: [court({ surface: 'clay' })] }), save({ courts: [court({ status: 'deleted' })] }),
    save({ courts: [court({ is_indoor: 'no' })] }), save({ courts: [court({ venue_id: VENUE })] }),
    save({ courts: [court(), court()] }), save({ courts: [court({ id: null }), court({ id: null })] }),
    save({ courts: Array.from({ length: 41 }, (_, n) => court({ id: null, name: `Court ${n}` })) }),
    JSON.stringify({ kind: 'remove_photo', venue_id: VENUE }),
    `{"kind":"save","pad":"${'x'.repeat(33 * 1024)}"}`,
  ]) assert.throws(() => readOwnerVenueCommand(body), VenueInputError, body.slice(0, 80));
  assert.throws(() => readOwnerVenueCommand(save({ courts: [court(), court({ id: null })] })), /Two courts are named “Court 1”/);
});

test('photo uploads, queries and dimension limits', () => {
  assert.deepEqual(readOwnerPhotoAdd(JSON.stringify({ venue_id: VENUE, request_id: COURT })), { venue_id: VENUE.toLowerCase(), request_id: COURT.toLowerCase() });
  for (const body of ['{}', JSON.stringify({ venue_id: VENUE }), JSON.stringify({ venue_id: VENUE, request_id: COURT, path: 'x' })]) {
    assert.throws(() => readOwnerPhotoAdd(body), VenueInputError);
  }
  assert.deepEqual(readOwnerVenueQuery(new URLSearchParams()), { venue_id: null });
  assert.deepEqual(readOwnerVenueQuery(new URLSearchParams({ venue_id: VENUE })), { venue_id: VENUE.toLowerCase() });
  for (const query of ['venue_id=x', 'venue=' + VENUE, `venue_id=${VENUE}&venue_id=${VENUE}`]) {
    assert.throws(() => readOwnerVenueQuery(new URLSearchParams(query)), VenueInputError);
  }
  assert.ok(photoDimensionsAllowed(4032, 3024) && photoDimensionsAllowed(5712, 4284) && photoDimensionsAllowed(320, 320));
  for (const [width, height] of [[319, 900], [900, 319], [8193, 900], [6000, 5000], [1200.5, 900], [NaN, 900]]) {
    assert.equal(photoDimensionsAllowed(width, height), false, `${width}x${height}`);
  }
});
