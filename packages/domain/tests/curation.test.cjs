const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readDirectorySave, readDirectoryImport, readDirectoryPublication, DirectoryInputError } = require('../src/curation.ts');
const venue = { name: ' Test venue ', address_line: 'Test address', city: 'Manila', province: 'Metro Manila', latitude: 14.6, longitude: 121 };
const court = { id: null, name: 'Court 1', surface: null, is_indoor: false, is_covered: true, status: 'active' };
const saved = { id: 'a1000000-0000-4000-8000-000000000001', expected_updated_at: '2026-10-07T00:00:00.123456+00:00', venue, courts: [court] };
test('curation normalizes directory fields and preserves database timestamp precision', () => {
  const value = readDirectorySave(saved);
  assert.equal(value.venue.name, 'Test venue');
  assert.equal(value.expected_updated_at, saved.expected_updated_at);
  assert.equal(readDirectorySave({ ...saved, id: null, expected_updated_at: null }).id, null);
  assert.equal(readDirectoryPublication({ id: saved.id, expected_updated_at: saved.expected_updated_at, publication_status: 'approved' }).publication_status, 'approved');
});
test('bad coordinates, unknown authority fields, invalid court values and oversized input fail', () => {
  for (const input of [
    { ...saved, actor_user_id: saved.id }, { ...saved, venue: { ...venue, claim_status: 'verified' } },
    ...[NaN, Infinity, 91, '14.6'].map(latitude => ({ ...saved, venue: { ...venue, latitude } })),
    { ...saved, venue: { ...venue, longitude: -181 } }, { ...saved, venue: { ...venue, name: ' ' } },
    { ...saved, venue: { ...venue, city: 'x'.repeat(81) } }, { ...saved, courts: [court, court] },
    ...[{ surface: 'clay' }, { is_indoor: 'false' }, { status: 'published' }, { id: 'invalid' }, { venue_id: saved.id }].map(patch => ({ ...saved, courts: [{ ...court, ...patch }] })),
    { ...saved, expected_updated_at: null }, { ...saved, courts: Array.from({ length: 41 }, (_, i) => ({ ...court, name: `Court ${i}` })) },
    { ...saved, id: null, expected_updated_at: null, courts: [{ ...court, id: saved.id }] },
  ]) assert.throws(() => readDirectorySave(input), DirectoryInputError);
});
test('imports require bounded unique references, complete entries and new court IDs', () => {
  const entry = { reference: ' source:001 ', venue, courts: [court] };
  assert.equal(readDirectoryImport({ listings: [entry] })[0].reference, 'source:001');
  for (const listings of [[], Array(26).fill(entry), [entry, entry], [{ ...entry, reference: '' }], [{ ...entry, publication_status: 'approved' }], [{ ...entry, courts: [{ ...court, id: saved.id }] }]]) assert.throws(() => readDirectoryImport({ listings }), DirectoryInputError);
});

const bulk = require('../src/curation.ts');
test('bulk actions: a known action, 1-100 distinct listings, each with its exact version', () => {
  const item = { id: 'A1000000-0000-4000-8000-000000000001', expected_updated_at: '2026-10-07T00:00:00.123456+00:00' };
  assert.deepEqual(bulk.readDirectoryBulk({ action: 'delete', items: [item] }),
    { action: 'delete', items: [{ id: 'a1000000-0000-4000-8000-000000000001', expected_updated_at: '2026-10-07T00:00:00.123456+00:00' }] });
  assert.deepEqual(bulk.BULK_PUBLICATION_STATUS, { publish: 'approved', draft: 'draft', suspend: 'suspended' });
  const many = Array.from({ length: 101 }, (_, n) => ({ id: `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`, expected_updated_at: item.expected_updated_at }));
  assert.equal(bulk.readDirectoryBulk({ action: 'publish', items: many.slice(0, 100) }).items.length, bulk.MAX_DIRECTORY_BULK);
  for (const bad of [null, { action: 'archive', items: [item] }, { action: 'publish', items: [] }, { action: 'publish', items: many },
    { action: 'publish', items: [item, { ...item, id: item.id.toLowerCase() }] }, { action: 'publish', items: [{ ...item, expected_updated_at: 'yesterday' }] },
    { action: 'publish', items: [{ id: 'nope', expected_updated_at: item.expected_updated_at }] }, { action: 'publish', items: [{ ...item, extra: 1 }] },
    { action: 'publish', items: [item], extra: true }, { action: 'toString', items: [item] }]) {
    assert.throws(() => bulk.readDirectoryBulk(bad), bulk.DirectoryInputError, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('export: selected listings in the import format, stable references, new court rows, the import limit', () => {
  const listing = (n) => ({ id: `a1000000-0000-4000-8000-00000000000${n}`, ...venue, name: `Venue ${n}`, country_code: 'PH', publication_status: 'approved',
    claim_status: 'unclaimed', created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z',
    courts: [{ ...court, id: `c1000000-0000-4000-8000-00000000000${n}`, venue_id: 'x', created_at: 'x', updated_at: 'x' },
      { ...court, id: `c2000000-0000-4000-8000-00000000000${n}`, name: 'Court 2', surface: 'hard', status: 'inactive', venue_id: 'x', created_at: 'x', updated_at: 'x' }] });
  const exported = bulk.directoryExport([listing(1), listing(2)]);
  assert.deepEqual(exported.listings[0], { reference: 'pickly-export:a1000000-0000-4000-8000-000000000001',
    venue: { name: 'Venue 1', address_line: 'Test address', city: 'Manila', province: 'Metro Manila', latitude: 14.6, longitude: 121 },
    courts: [{ id: null, name: 'Court 1', surface: null, is_indoor: false, is_covered: true, status: 'active' },
      { id: null, name: 'Court 2', surface: 'hard', is_indoor: false, is_covered: true, status: 'inactive' }] });
  assert.deepEqual(readDirectoryImport(JSON.parse(JSON.stringify(exported))), exported.listings, 'the export is a valid import');
  assert.throws(() => bulk.directoryExport([]), bulk.DirectoryInputError);
  assert.throws(() => bulk.directoryExport(Array.from({ length: 26 }, () => listing(1))), /25 listings/);
});
