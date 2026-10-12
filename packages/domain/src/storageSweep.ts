/**
 * T51b: the storage cleanup worker. Owner proof photos are removed 30 days after their review decision, and
 * objects nothing references are removed after a 24-hour grace, in these three buckets only. SQL chooses what
 * is due and records what is gone; the storage-sweep function removes objects through the Storage API. See
 * docs/privacy.md#storage-cleanup-t51b.
 */
export const STORAGE_SWEEP_BUCKETS = ['owner-evidence', 'venue-photos', 'avatars'] as const;
export type StorageSweepBucket = typeof STORAGE_SWEEP_BUCKETS[number];
/** Decided evidence past its retention; an object no claim, submission, venue photo or avatar names. */
export const STORAGE_SWEEP_REASONS = ['evidence_retention', 'unreferenced'] as const;
export type StorageSweepReason = typeof STORAGE_SWEEP_REASONS[number];
/** The same values as the migration (20261012090000_storage_sweep.sql); a contract test ties them together. */
export const EVIDENCE_RETENTION_DAYS = 30;
export const UNREFERENCED_GRACE_HOURS = 24;
/** storage_sweep_due and storage_sweep_confirm accept up to this many; Storage removes up to 1000 names per call. */
export const STORAGE_SWEEP_MAX_BATCH = 1000;
export const STORAGE_SWEEP_MAX_PATH = 1024;

export type StorageSweepItem = { bucket: StorageSweepBucket; path: string; reason: StorageSweepReason };
export type StorageSweepDue = { items: StorageSweepItem[]; more: boolean };
/** Purges recorded by this confirmation, and items whose object is still present (retried next run). */
export type StorageSweepConfirm = { purged: number; remaining: number };

const object = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Unexpected storage sweep reply.');
  return raw as Record<string, unknown>;
};
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= STORAGE_SWEEP_MAX_BATCH;
export const isStorageSweepBucket = (value: unknown): value is StorageSweepBucket =>
  typeof value === 'string' && (STORAGE_SWEEP_BUCKETS as readonly string[]).includes(value);
const isReason = (value: unknown): value is StorageSweepReason => typeof value === 'string' && (STORAGE_SWEEP_REASONS as readonly string[]).includes(value);

/** Strict `storage_sweep_due` reply. Object names come from Storage itself, so any non-empty name is accepted. */
export function readStorageSweepDue(raw: unknown): StorageSweepDue {
  const due = object(raw);
  if (!Array.isArray(due.items) || due.items.length > STORAGE_SWEEP_MAX_BATCH || typeof due.more !== 'boolean') throw new Error('Unexpected storage sweep reply.');
  return { more: due.more, items: due.items.map((value) => {
    const item = object(value);
    if (!isStorageSweepBucket(item.bucket) || !isReason(item.reason) || typeof item.path !== 'string'
      || item.path.length < 1 || item.path.length > STORAGE_SWEEP_MAX_PATH) throw new Error('Unexpected storage sweep reply.');
    return { bucket: item.bucket, path: item.path, reason: item.reason };
  }) };
}

/** Strict `storage_sweep_confirm` reply. */
export function readStorageSweepConfirm(raw: unknown): StorageSweepConfirm {
  const reply = object(raw);
  if (!isCount(reply.purged) || !isCount(reply.remaining)) throw new Error('Unexpected storage sweep reply.');
  return { purged: reply.purged, remaining: reply.remaining };
}
