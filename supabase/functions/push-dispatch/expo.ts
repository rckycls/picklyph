import type { PushData } from '../../../packages/domain/src/notification.ts';
/** Expo push service (https://docs.expo.dev/push-notifications/sending-notifications/). Server-only. */
export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
/** Expo accepts at most 100 messages per send and 1000 ids per receipt request. */
export const EXPO_SEND_LIMIT = 100;
export const EXPO_RECEIPT_LIMIT = 1000;
export type ExpoMessage = { to: string; title: string; body: string; sound: 'default'; data: PushData };
export type ExpoTicketOutcome = { outcome: 'ok'; ticket_id: string | null } | { outcome: 'invalid' | 'retry' } | { outcome: 'error'; error: string };
export type ExpoSendResult = { outcomes: ExpoTicketOutcome[]; retryAfterSeconds?: number };
export type ExpoReceipt = { outcome: 'ok' | 'invalid' } | { outcome: 'error'; error: string };

const TICKET = /^[A-Za-z0-9-]{1,100}$/;
// Errors that no retry can fix: the message or the project's credentials are wrong.
const PERMANENT: Record<string, string> = { MessageTooBig: 'message_too_big', InvalidCredentials: 'invalid_credentials', MismatchSenderId: 'mismatch_sender_id' };
const detail = (raw: Record<string, unknown>) => {
  const details = raw.details;
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>).error : undefined;
};

/** One send ticket. DeviceNotRegistered → invalid (the token is disabled); rate limits and unknown errors → retry. */
export function classifyTicket(raw: unknown): ExpoTicketOutcome {
  if (typeof raw !== 'object' || raw === null) return { outcome: 'retry' };
  const ticket = raw as Record<string, unknown>;
  if (ticket.status === 'ok') return { outcome: 'ok', ticket_id: typeof ticket.id === 'string' && TICKET.test(ticket.id) ? ticket.id : null };
  if (ticket.status !== 'error') return { outcome: 'retry' };
  const code = detail(ticket);
  if (code === 'DeviceNotRegistered') return { outcome: 'invalid' };
  if (typeof code === 'string' && PERMANENT[code]) return { outcome: 'error', error: PERMANENT[code]! };
  return { outcome: 'retry' };
}

/** One receipt. Undefined when Expo has nothing usable for the id yet. */
export function classifyReceipt(raw: unknown): ExpoReceipt | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const receipt = raw as Record<string, unknown>;
  if (receipt.status === 'ok') return { outcome: 'ok' };
  if (receipt.status !== 'error') return undefined;
  const code = detail(receipt);
  if (code === 'DeviceNotRegistered') return { outcome: 'invalid' };
  return { outcome: 'error', error: typeof code === 'string' && PERMANENT[code] ? PERMANENT[code]! : code === 'MessageRateExceeded' ? 'message_rate_exceeded' : 'expo_error' };
}

const retryAfter = (value: string | null) => {
  if (!value || !/^\d{1,5}$/.test(value)) return undefined;
  return Math.min(3600, Number(value));
};

export function createExpoPush(fetcher: typeof fetch, accessToken?: string) {
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) };
  return {
    /** Never throws: a transport failure, 429 or 5xx retries every message; another 4xx fails them. */
    send: async (messages: ExpoMessage[]): Promise<ExpoSendResult> => {
      if (messages.length === 0 || messages.length > EXPO_SEND_LIMIT) throw new Error('Expo send batch size');
      const retry = (after?: number): ExpoSendResult => ({ outcomes: messages.map(() => ({ outcome: 'retry' as const })), ...(after ? { retryAfterSeconds: after } : {}) });
      let response: Response;
      try { response = await fetcher(EXPO_SEND_URL, { method: 'POST', headers, body: JSON.stringify(messages) }); } catch { return retry(); }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => {});
        return retry(retryAfter(response.headers.get('retry-after')));
      }
      let body: unknown;
      try { body = await response.json(); } catch { return retry(); }
      if (!response.ok) return { outcomes: messages.map(() => ({ outcome: 'error' as const, error: 'expo_rejected' })) };
      const data = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).data : undefined;
      // Tickets come back in message order; any other shape is treated as not sent.
      if (!Array.isArray(data) || data.length !== messages.length) return retry();
      return { outcomes: data.map(classifyTicket) };
    },
    /** Null when Expo could not answer; the tickets stay due for a later run. */
    receipts: async (ids: string[]): Promise<Map<string, ExpoReceipt> | null> => {
      if (ids.length === 0 || ids.length > EXPO_RECEIPT_LIMIT) throw new Error('Expo receipt batch size');
      let response: Response;
      try { response = await fetcher(EXPO_RECEIPTS_URL, { method: 'POST', headers, body: JSON.stringify({ ids }) }); } catch { return null; }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
      let body: unknown;
      try { body = await response.json(); } catch { return null; }
      const data = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).data : undefined;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
      const receipts = new Map<string, ExpoReceipt>();
      for (const id of ids) {
        const receipt = classifyReceipt((data as Record<string, unknown>)[id]);
        if (receipt) receipts.set(id, receipt);
      }
      return receipts;
    },
  };
}
