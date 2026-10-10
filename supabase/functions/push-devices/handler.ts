import { MAX_PUSH_DEVICE_BYTES, readPushDeviceCommand, type NotificationPreferences, type NotificationTopic, type PushDeviceRegister,
  type PushDeviceUnregister } from '../../../packages/domain/src/notification.ts';
import type { RateAction, RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';
export const PUSH_DEVICE_STATUS: Record<string, number> = { invalid_request: 400, account_deleted: 403 };
export class PushDeviceRejected extends Error {
  constructor(readonly reason: string) { super(reason); }
}
type Dependencies = {
  verifyUser: (token: string) => Promise<string | null>;
  limit: (action: Extract<RateAction, 'push-register' | 'push-preferences'>, principal: RatePrincipal) => Promise<RateDecision>;
  register: (actor: string, command: PushDeviceRegister) => Promise<void>;
  unregister: (actor: string, command: PushDeviceUnregister) => Promise<void>;
  readPreferences: (actor: string) => Promise<NotificationPreferences>;
  savePreferences: (actor: string, muted: NotificationTopic[]) => Promise<NotificationPreferences>;
};
/**
 * /functions/v1/push-devices: the signed-in caller registers or removes this phone's Expo push token
 * (T43), and reads (`GET ?section=preferences`) or replaces (`POST {kind:'preferences', muted}`) the
 * account's alert switches (T45). The body never names an account; the server uses the verified caller.
 * Both buckets keep working in a Redis outage: the commands are idempotent, self-only and create no inventory.
 */
export function createPushDevicesHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (request.method !== 'POST' && request.method !== 'GET') return respond(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST' });
    if (request.url.length > 2048) return respond(400, { error: 'invalid_request' });
    const search = new URL(request.url).search;
    if (request.method === 'GET' ? search !== '?section=preferences' : search) return respond(400, { error: 'invalid_request' });
    const token = /^Bearer ([^\s]{1,4096})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return respond(401, { error: 'sign_in_required' });
    let actor: string | null;
    try { actor = await deps.verifyUser(token); } catch { return respond(503, { error: 'auth_unavailable' }, { 'Retry-After': '5' }); }
    if (!actor) return respond(401, { error: 'invalid_auth' });
    let command: ReturnType<typeof readPushDeviceCommand> | { kind: 'read_preferences' } = { kind: 'read_preferences' };
    if (request.method === 'POST') {
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return respond(415, { error: 'unsupported_media_type' });
      try {
        const declared = request.headers.get('content-length');
        if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_PUSH_DEVICE_BYTES)) return respond(413, { error: 'request_too_large' });
        const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        if (reader) for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > MAX_PUSH_DEVICE_BYTES) { await reader.cancel().catch(() => {}); return respond(413, { error: 'request_too_large' }); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        command = readPushDeviceCommand(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      } catch { return respond(400, { error: 'invalid_request' }); }
    }
    const devices = command.kind === 'register' || command.kind === 'unregister';
    let decision: RateDecision;
    try { decision = await deps.limit(devices ? 'push-register' : 'push-preferences', { kind: 'user', id: actor }); }
    catch { return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '5' }); }
    if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
    try {
      switch (command.kind) {
        case 'register': await deps.register(actor, command); return respond(200, { status: 'registered' }, decision.headers);
        case 'unregister': await deps.unregister(actor, command); return respond(200, { status: 'removed' }, decision.headers);
        case 'preferences': return respond(200, await deps.savePreferences(actor, command.muted), decision.headers);
        case 'read_preferences': return respond(200, await deps.readPreferences(actor), decision.headers);
      }
    } catch (error) {
      if (error instanceof PushDeviceRejected && PUSH_DEVICE_STATUS[error.reason]) return respond(PUSH_DEVICE_STATUS[error.reason]!, { error: error.reason }, decision.headers);
      return respond(503, { error: 'temporarily_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
    }
  };
}
