import { isNotificationKind, notificationMessage, readNotificationPayload, type PushClaim, type PushCompletion, type PushReceiptOutcome } from '../../../packages/domain/src/notification.ts';
import { EXPO_RECEIPT_LIMIT, EXPO_SEND_LIMIT, type ExpoMessage, type ExpoReceipt, type ExpoSendResult } from './expo.ts';
/** Rows per claim and their lease. A run stops starting Expo calls after RUN_BUDGET_MS, well inside the lease. */
export const PUSH_BATCH = 25;
export const LEASE_SECONDS = 120;
export const MAX_ROUNDS = 4;
export const RUN_BUDGET_MS = 20_000;
export const RECEIPT_BATCH = 300;
export type DispatchSummary = { claimed: number; sent: number; retried: number; invalid: number; failed: number; stale: number; receipts: number };
type Dependencies = {
  /** PUSH_WORKER_SECRET: at least 32 characters, also stored in Vault for the pg_cron caller. */
  secret: string | undefined;
  claim: (batch: number, leaseSeconds: number) => Promise<PushClaim>;
  complete: (results: PushCompletion[]) => Promise<{ completed: number; stale: number }>;
  receiptsDue: (batch: number) => Promise<string[]>;
  recordReceipts: (results: PushReceiptOutcome[]) => Promise<number>;
  /** Never throws; see expo.ts. */
  send: (messages: ExpoMessage[]) => Promise<ExpoSendResult>;
  receipts: (ids: string[]) => Promise<Map<string, ExpoReceipt> | null>;
  now?: () => number;
};

async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

/** One worker run: claim → send → complete, a few rounds while there is time, then receipts. */
export async function dispatchOnce(deps: Dependencies): Promise<DispatchSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const inBudget = () => now() - started < RUN_BUDGET_MS;
  const totals: DispatchSummary = { claimed: 0, sent: 0, retried: 0, invalid: 0, failed: 0, stale: 0, receipts: 0 };
  for (let round = 0; round < MAX_ROUNDS && inBudget(); round++) {
    const claim = await deps.claim(PUSH_BATCH, LEASE_SECONDS);
    if (claim.items.length === 0) break;
    totals.claimed += claim.items.length;
    const completions: PushCompletion[] = [];
    const queue: { completion: PushCompletion; device: string; message: ExpoMessage }[] = [];
    for (const item of claim.items) {
      const completion: PushCompletion = { id: item.id, claim_id: item.claim_id, deliveries: [] };
      completions.push(completion);
      let message: { title: string; body: string } | null = null;
      let payload;
      try {
        payload = readNotificationPayload(item.payload);
        if (isNotificationKind(item.kind)) message = notificationMessage(item.kind, payload);
      } catch { message = null; }
      if (!message || !payload) {
        for (const device of item.devices) completion.deliveries.push({ device_id: device.id, outcome: 'error', error: 'invalid_payload' });
        totals.failed += item.devices.length;
        continue;
      }
      const data = { notification_id: item.id, kind: item.kind, audience: payload.audience, booking_kind: payload.booking_kind, booking_id: payload.booking_id };
      for (const device of item.devices) {
        queue.push({ completion, device: device.id, message: { to: device.token, title: message.title, body: message.body, sound: 'default', data } });
      }
    }
    for (let start = 0; start < queue.length; start += EXPO_SEND_LIMIT) {
      const chunk = queue.slice(start, start + EXPO_SEND_LIMIT);
      // Out of time: leave the rest for the next run without calling Expo.
      const result: ExpoSendResult = inBudget() ? await deps.send(chunk.map((entry) => entry.message)) : { outcomes: chunk.map(() => ({ outcome: 'retry' as const })) };
      chunk.forEach((entry, index) => {
        const outcome = result.outcomes[index] ?? { outcome: 'retry' as const };
        entry.completion.deliveries.push({ device_id: entry.device, ...outcome });
        if (outcome.outcome === 'ok') totals.sent++;
        else if (outcome.outcome === 'retry') totals.retried++;
        else if (outcome.outcome === 'invalid') totals.invalid++;
        else totals.failed++;
        if (outcome.outcome === 'retry' && result.retryAfterSeconds) {
          entry.completion.retry_after_seconds = Math.max(entry.completion.retry_after_seconds ?? 0, result.retryAfterSeconds);
        }
      });
    }
    // Expo already has these messages: one immediate retry before the lease is left to expire.
    let done;
    try { done = await deps.complete(completions); } catch { done = await deps.complete(completions); }
    totals.stale += done.stale;
    if (!claim.more) break;
  }
  const tickets = await deps.receiptsDue(Math.min(RECEIPT_BATCH, EXPO_RECEIPT_LIMIT));
  if (tickets.length > 0) {
    const receipts = await deps.receipts(tickets);
    const outcomes: PushReceiptOutcome[] = [];
    if (receipts) for (const ticket of tickets) {
      const receipt = receipts.get(ticket);
      if (receipt) outcomes.push({ ticket_id: ticket, ...receipt });
    }
    if (outcomes.length > 0) totals.receipts = await deps.recordReceipts(outcomes);
  }
  return totals;
}

/**
 * POST /functions/v1/push-dispatch: the notification worker (T43), called every minute by pg_cron
 * through pg_net when something is due. Only the PUSH_WORKER_SECRET bearer is accepted; user tokens
 * are not. Leases make concurrent runs safe: each outbox row is held by one run at a time.
 */
export function createPushDispatchHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (!deps.secret || deps.secret.length < 32) return respond(503, { error: 'not_configured' });
    const presented = /^Bearer ([^\s]{1,512})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!presented || !(await sameSecret(presented, deps.secret))) return respond(401, { error: 'unauthorized' });
    // The body carries nothing; the outbox decides what is due.
    await request.body?.cancel().catch(() => {});
    try { return respond(200, await dispatchOnce(deps)); }
    catch { return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '30' }); }
  };
}
