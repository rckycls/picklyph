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
