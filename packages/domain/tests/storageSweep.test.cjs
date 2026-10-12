const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { STORAGE_SWEEP_BUCKETS, STORAGE_SWEEP_REASONS, EVIDENCE_RETENTION_DAYS, UNREFERENCED_GRACE_HOURS, STORAGE_SWEEP_MAX_BATCH,
  STORAGE_SWEEP_MAX_PATH, readStorageSweepDue, readStorageSweepConfirm, isStorageSweepBucket } = require('../src/storageSweep.ts');

const root = path.resolve(path.dirname(require.resolve('../src/storageSweep.ts')), '../../..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261012090000_storage_sweep.sql'), 'utf8');

test('the contract matches the migration: buckets, reasons, retention, grace and bounds', () => {
  const quoted = (list) => list.map((value) => `'${value}'`).join(',');
  assert.ok(migration.includes(`not in (${quoted(STORAGE_SWEEP_BUCKETS)})`), 'confirm accepts exactly these buckets');
  assert.ok(migration.includes(`not in (${quoted(STORAGE_SWEEP_REASONS)})`), 'confirm accepts exactly these reasons');
  const buckets = [...migration.matchAll(/o\.bucket_id = '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(buckets)].sort(), [...STORAGE_SWEEP_BUCKETS].sort(), 'candidates come from these buckets only');
  // The sweep's own section; the replaced ops_health below it keeps T51a's intervals.
  const sweep = migration.slice(0, migration.indexOf('-- The monitor:'));
  assert.ok(sweep.length > 1000);
  assert.deepEqual([...new Set([...sweep.matchAll(/interval '(\d+) days'/g)].map((m) => Number(m[1])))], [EVIDENCE_RETENTION_DAYS]);
  assert.deepEqual([...new Set([...sweep.matchAll(/interval '(\d+) hours'/g)].map((m) => Number(m[1])))], [UNREFERENCED_GRACE_HOURS]);
  assert.match(migration, new RegExp(`batch_limit not between 1 and ${STORAGE_SWEEP_MAX_BATCH}\\b`));
  assert.match(migration, new RegExp(`jsonb_array_length\\(items\\) > ${STORAGE_SWEEP_MAX_BATCH}\\b`));
  assert.match(migration, new RegExp(`not between 1 and ${STORAGE_SWEEP_MAX_PATH}\\b`));
  assert.ok(!isStorageSweepBucket('sweep-test-other') && !isStorageSweepBucket('toString') && isStorageSweepBucket('avatars'));
});

test('due and confirm replies parse strictly', () => {
  const item = { bucket: 'venue-photos', path: 'a1/b2.jpg', reason: 'unreferenced' };
  assert.deepEqual(readStorageSweepDue({ at: '2026-10-12T00:00:00Z', items: [item], more: true }), { items: [item], more: true });
  assert.deepEqual(readStorageSweepDue({ items: [], more: false }), { items: [], more: false });
  assert.deepEqual(readStorageSweepDue({ items: [{ ...item, path: 'x'.repeat(1024) }], more: false }).items[0].path.length, 1024);
  for (const bad of [null, [], { items: {}, more: false }, { items: [], more: 'no' }, { items: Array(1001).fill(item), more: false },
    { items: [{ ...item, bucket: 'other' }], more: false }, { items: [{ ...item, reason: 'old' }], more: false },
    { items: [{ ...item, path: '' }], more: false }, { items: [{ ...item, path: 'x'.repeat(1025) }], more: false },
    { items: [{ ...item, path: 7 }], more: false }, { items: [null], more: false }]) {
    assert.throws(() => readStorageSweepDue(bad), /Unexpected storage sweep reply/, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.deepEqual(readStorageSweepConfirm({ purged: 2, remaining: 0 }), { purged: 2, remaining: 0 });
  for (const bad of [null, { purged: -1, remaining: 0 }, { purged: 1.5, remaining: 0 }, { purged: 0 }, { purged: 0, remaining: 1001 }, { purged: '1', remaining: 0 }]) {
    assert.throws(() => readStorageSweepConfirm(bad), /Unexpected storage sweep reply/, JSON.stringify(bad));
  }
});
