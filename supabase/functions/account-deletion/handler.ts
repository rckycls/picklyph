import { MAX_ACCOUNT_DELETION_BYTES, readAccountDeletionRequest } from '../../../packages/domain/src/privacy.ts';
import type { RateAction, RateDecision, RatePrincipal } from '../_shared/rate-limit.ts';
export const DELETION_STATUS: Record<string, number> = { privileged_account: 403 };
export class DeletionRejected extends Error {
  constructor(readonly reason: string) { super(reason); }
}
/** `missing`: Auth verified the token but its account no longer exists. */
export type VerifiedCaller = { kind: 'user' | 'missing'; id: string } | null;
export const DELETION_BUCKETS = ['avatars', 'owner-evidence'] as const;
type Dependencies = {
  verifyUser: (token: string) => Promise<VerifiedCaller>;
  limit: (action: Extract<RateAction, 'account-delete'>, principal: RatePrincipal) => Promise<RateDecision>;
  begin: (actor: string) => Promise<unknown>;
  status: (user: string) => Promise<'none' | 'pending' | 'deleted'>;
  removeFolder: (bucket: typeof DELETION_BUCKETS[number], folder: string) => Promise<void>;
  deleteUser: (actor: string) => Promise<void>;
};
/**
 * POST /functions/v1/account-deletion: the signed-in user deletes their own account (T47).
 * Order: database begin (cancel, release, erase; retry-safe) → empty the account's storage
 * folders → delete the Auth user. Any failure before the last step answers 503 and a retry
 * resumes; the Auth user is never deleted while its files remain.
 */
export function createAccountDeletionHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status, headers: { 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json', ...headers },
    });
    if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (request.url.length > 2048 || new URL(request.url).search) return respond(400, { error: 'invalid_request' });
    const token = /^Bearer ([^\s]{1,4096})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return respond(401, { error: 'sign_in_required' });
    let caller: VerifiedCaller;
    try { caller = await deps.verifyUser(token); } catch { return respond(503, { error: 'auth_unavailable' }, { 'Retry-After': '5' }); }
    if (!caller) return respond(401, { error: 'invalid_auth' });
    if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return respond(415, { error: 'unsupported_media_type' });
    try {
      const declared = request.headers.get('content-length');
      if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > MAX_ACCOUNT_DELETION_BYTES)) return respond(413, { error: 'request_too_large' });
      const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_ACCOUNT_DELETION_BYTES) { await reader.cancel().catch(() => {}); return respond(413, { error: 'request_too_large' }); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      readAccountDeletionRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch { return respond(400, { error: 'invalid_request' }); }
    // A retry after a lost reply: the token is genuine but its account is gone. Confirm only a deletion that started here.
    if (caller.kind === 'missing') {
      try { return (await deps.status(caller.id)) === 'deleted' ? respond(200, { status: 'deleted' }) : respond(401, { error: 'invalid_auth' }); }
      catch { return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '5' }); }
    }
    const actor = caller.id;
    let decision: RateDecision;
    try { decision = await deps.limit('account-delete', { kind: 'user', id: actor }); }
    catch { return respond(503, { error: 'temporarily_unavailable' }, { 'Retry-After': '5' }); }
    if (!decision.allowed) return respond(decision.status, { error: decision.status === 429 ? 'rate_limited' : 'temporarily_unavailable' }, decision.headers);
    try {
      await deps.begin(actor);
      for (const bucket of DELETION_BUCKETS) await deps.removeFolder(bucket, actor);
      await deps.deleteUser(actor);
    } catch (error) {
      if (error instanceof DeletionRejected && DELETION_STATUS[error.reason]) return respond(DELETION_STATUS[error.reason]!, { error: error.reason }, decision.headers);
      return respond(503, { error: 'temporarily_unavailable' }, { ...decision.headers, 'Retry-After': '5' });
    }
    return respond(200, { status: 'deleted' }, decision.headers);
  };
}
