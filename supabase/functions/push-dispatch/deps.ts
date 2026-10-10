import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { isExpoPushToken, isNotificationKind, type PushClaim, type PushCompletion, type PushReceiptOutcome } from '../../../packages/domain/src/notification.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET = /^[A-Za-z0-9-]{1,100}$/;
const record = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Unexpected claim.');
  return raw as Record<string, unknown>;
};

/** Strict `push_outbox_claim` reply; the payload itself is parsed per row by the handler. */
export function readPushClaim(raw: unknown): PushClaim {
  const claim = record(raw);
  if (!Array.isArray(claim.items) || claim.items.length > 100 || typeof claim.more !== 'boolean') throw new Error('Unexpected claim.');
  return { more: claim.more, items: claim.items.map((value) => {
    const item = record(value);
    if (typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.claim_id !== 'string' || !UUID.test(item.claim_id)
      || !isNotificationKind(item.kind) || !Array.isArray(item.devices) || item.devices.length < 1 || item.devices.length > 10) throw new Error('Unexpected claim.');
    return { id: item.id, claim_id: item.claim_id, kind: item.kind, payload: item.payload, devices: item.devices.map((entry) => {
      const device = record(entry);
      if (typeof device.id !== 'string' || !UUID.test(device.id) || !isExpoPushToken(device.token)) throw new Error('Unexpected claim.');
      return { id: device.id, token: device.token };
    }) };
  }) };
}

export function createSupabasePushDispatchDeps(server: () => SupabaseClient<Database>) {
  return {
    claim: async (batch: number, leaseSeconds: number) => {
      const { data, error } = await server().rpc('push_outbox_claim', { batch_limit: batch, lease_seconds: leaseSeconds });
      if (error) throw new Error('Outbox unavailable');
      return readPushClaim(data);
    },
    complete: async (results: PushCompletion[]) => {
      const { data, error } = await server().rpc('push_outbox_complete', { results });
      if (error || !data || !Number.isSafeInteger(data.completed) || !Number.isSafeInteger(data.stale)) throw new Error('Outbox unavailable');
      return data;
    },
    receiptsDue: async (batch: number) => {
      const { data, error } = await server().rpc('push_receipts_due', { batch_limit: batch });
      if (error || !data || !Array.isArray(data.tickets) || !data.tickets.every((ticket) => typeof ticket === 'string' && TICKET.test(ticket))) throw new Error('Outbox unavailable');
      return data.tickets;
    },
    recordReceipts: async (results: PushReceiptOutcome[]) => {
      const { data, error } = await server().rpc('push_receipts_record', { results });
      if (error || !data || !Number.isSafeInteger(data.recorded)) throw new Error('Outbox unavailable');
      return data.recorded;
    },
  };
}
