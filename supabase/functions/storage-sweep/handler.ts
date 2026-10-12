import { STORAGE_SWEEP_BUCKETS, type StorageSweepBucket, type StorageSweepConfirm, type StorageSweepDue, type StorageSweepItem } from '../../../packages/domain/src/storageSweep.ts';
/** Items per batch. A run stops starting batches after RUN_BUDGET_MS, well inside pg_net's 60-second timeout. */
export const SWEEP_BATCH = 200;
export const MAX_ROUNDS = 10;
export const RUN_BUDGET_MS = 30_000;
/** due/removed/purged/remaining add up over the run; `refused` counts Storage calls that failed; `more` means a later run continues. */
export type SweepSummary = { due: number; removed: number; purged: number; remaining: number; refused: number; rounds: number; more: boolean };
type Dependencies = {
  /** STORAGE_SWEEP_SECRET: at least 32 characters, also stored in Vault for the pg_cron caller. */
  secret: string | undefined;
  due: (batch: number) => Promise<StorageSweepDue>;
  /** Removes names from one bucket through the Storage API and resolves with how many it removed; throws when Storage refused. */
  remove: (bucket: StorageSweepBucket, paths: string[]) => Promise<number>;
  confirm: (items: StorageSweepItem[]) => Promise<StorageSweepConfirm>;
  now?: () => number;
};

async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

/**
 * One run: due → one Storage removal per bucket → confirm, a few rounds while there is time. Confirmation is
 * the record: it purges evidence only once its object is gone. Anything still present comes first in the next
 * batch too, so the run stops there instead of asking for it again; tomorrow's run retries it.
 */
export async function sweepOnce(deps: Dependencies): Promise<SweepSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const totals: SweepSummary = { due: 0, removed: 0, purged: 0, remaining: 0, refused: 0, rounds: 0, more: false };
  for (let round = 0; round < MAX_ROUNDS && now() - started < RUN_BUDGET_MS; round++) {
    const due = await deps.due(SWEEP_BATCH);
    totals.rounds += 1;
    totals.more = due.more;
    if (due.items.length === 0) break;
    totals.due += due.items.length;
    for (const bucket of STORAGE_SWEEP_BUCKETS) {
      const paths = due.items.filter((item) => item.bucket === bucket).map((item) => item.path);
      if (paths.length === 0) continue;
      try { totals.removed += await deps.remove(bucket, paths); } catch { totals.refused += 1; }
    }
    const confirmed = await deps.confirm(due.items);
    totals.purged += confirmed.purged;
    totals.remaining += confirmed.remaining;
    if (confirmed.remaining > 0 || !due.more) break;
  }
  return totals;
}

/**
 * POST /functions/v1/storage-sweep (T51b): called daily by pg_cron through pg_net. Only the STORAGE_SWEEP_SECRET
 * bearer is accepted. 200 with the run's counts; 502 `storage_refused` when Storage refused a removal (the
 * monitor counts it as an Edge error, and the next run retries); 503 when the database is unreachable.
 */
export function createStorageSweepHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (!deps.secret || deps.secret.length < 32) return respond(503, { error: 'not_configured' });
    const presented = /^Bearer ([^\s]{1,512})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!presented || !(await sameSecret(presented, deps.secret))) return respond(401, { error: 'unauthorized' });
    let summary: SweepSummary;
    try { summary = await sweepOnce(deps); } catch { return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '300' }); }
    return summary.refused > 0 ? respond(502, { error: 'storage_refused', ...summary }) : respond(200, summary);
  };
}
