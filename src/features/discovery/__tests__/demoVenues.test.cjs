const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getDemoVenues, PHILIPPINES_REGION } = require('../demoVenues.ts');

test('release mode does not expose demo venues as the directory', () => {
  assert.deepEqual(getDemoVenues(false), []);
});

test('three clearly labeled sample locations fit the national fallback region', () => {
  const venues = getDemoVenues(true);
  assert.equal(venues.length, 3);
  assert.equal(new Set(venues.map((venue) => venue.id)).size, 3);
  for (const venue of venues) {
    assert(venue.id.startsWith('demo-') && venue.name.startsWith('Demo · '));
    assert(Math.abs(venue.coordinates.latitude - PHILIPPINES_REGION.latitude) < PHILIPPINES_REGION.latitudeDelta / 2);
    assert(Math.abs(venue.coordinates.longitude - PHILIPPINES_REGION.longitude) < PHILIPPINES_REGION.longitudeDelta / 2);
  }
});
