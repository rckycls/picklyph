const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadVenueDetail } = require('../venueDetail.ts');

function client(photoResult, publication = true) {
  const venue = { id: 'b5000000-0000-4000-8000-000000000001', name: 'Venue', address_line: 'Address', city: 'Manila', province: 'Metro Manila',
    latitude: 14.6, longitude: 121, claim_status: 'verified' };
  const court = { id: 'c5000000-0000-4000-8000-000000000001', name: 'Court 1', surface: 'hard', is_indoor: false, is_covered: true };
  const seen = [];
  return { seen, from: (table) => {
    const query = { select: () => query, eq: () => query, order: () => query, limit: (count) => { seen.push([table, count]); return query; },
      abortSignal: () => query, maybeSingle: async () => ({ data: publication ? venue : null, error: null }),
      then: (resolve, reject) => Promise.resolve(table === 'venue_photos' ? photoResult : { data: [court], error: null }).then(resolve, reject) };
    return query;
  } };
}

test('public details include bounded photo rows and remain usable before the photo migration', async () => {
  const photos = [{ id: 'd5000000-0000-4000-8000-000000000001', storage_path: 'b5000000-0000-4000-8000-000000000001/d5000000-0000-4000-8000-000000000001.jpg', width: 800, height: 600, created_at: '2026-10-07T00:00:00Z' }];
  const live = client({ data: photos, error: null });
  const result = await loadVenueDetail(live, 'venue');
  assert.deepEqual(result.photos, photos); assert.equal(result.courts.length, 1);
  assert.ok(live.seen.some(([table, limit]) => table === 'venue_photos' && limit === 6));
  for (const code of ['PGRST205', '42P01']) {
    const old = await loadVenueDetail(client({ data: null, error: { code } }), 'venue');
    assert.deepEqual(old.photos, []); assert.equal(old.courts.length, 1);
  }
  await assert.rejects(loadVenueDetail(client({ data: null, error: { code: '42501' } }), 'venue'), /unavailable/);
  assert.equal(await loadVenueDetail(client({ data: [], error: null }, false), 'venue'), null);
});
