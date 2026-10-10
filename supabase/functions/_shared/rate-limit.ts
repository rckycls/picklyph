/** Server-only. Principals MUST come from verified Auth or a trusted ingress. */
export type RatePrincipal = { kind: 'user' | 'guest' | 'provider'; id: string };
export type RateAction = 'discovery' | 'owner-lookup' | 'owner-submit' | 'owner-read' | 'owner-edit' | 'owner-ops' | 'hold-create' | 'checkout-create' | 'report-create' | 'account-delete' | 'push-register' | 'cancel' | 'provider-webhook';
export type LimitReply = { success: boolean; limit: number; remaining: number; reset: number; reason?: string; pending?: Promise<unknown> };
export type RateDecision = { allowed: boolean; status: 200 | 429 | 503; state: 'enforced' | 'degraded' | 'bypassed'; headers: Record<string, string> };
export type RateBackend = (action: RateAction, principal: RatePrincipal, identifier: string) => Promise<LimitReply>;

export const RATE_POLICIES = {
  discovery: { user: 60, guest: 30, outage: 'continue' },
  // Address search is a paid provider call; nearby checks share the bucket.
  'owner-lookup': { user: 30, guest: 0, outage: 'reject' },
  'owner-submit': { user: 10, guest: 0, outage: 'reject' },
  // Verified-owner venue editing (T18): bounded reads continue in an outage; edits and uploads stop.
  'owner-read': { user: 60, guest: 0, outage: 'continue' },
  'owner-edit': { user: 20, guest: 0, outage: 'reject' },
  // Front-desk attendance/arrival-payment records (T31) create no inventory or charge, so the desk keeps working in an outage.
  'owner-ops': { user: 60, guest: 0, outage: 'continue' },
  'hold-create': { user: 10, guest: 0, outage: 'reject' },
  'checkout-create': { user: 5, guest: 0, outage: 'reject' },
  // Listing reports (T46) create reviewer work; signed-in players only, stopped in an outage.
  'report-create': { user: 5, guest: 0, outage: 'reject' },
  // Account deletion (T47) is a privacy right: like cancellation it keeps working in an outage.
  'account-delete': { user: 5, guest: 0, outage: 'continue' },
  // Push device registration (T43) is idempotent, capped per account and creates no inventory, so it continues in an outage.
  'push-register': { user: 10, guest: 0, outage: 'continue' },
  cancel: { user: 30, guest: 0, outage: 'continue' },
  'provider-webhook': { user: 0, guest: 0, outage: 'continue' },
} as const;

export function createRateGuard(options: {
  backend: RateBackend;
  identifier: (principal: RatePrincipal) => Promise<string>;
  timeoutMs?: number;
  now?: () => number;
}) {
  return async (action: RateAction, principal: RatePrincipal): Promise<RateDecision> => {
    if (!principal.id || principal.id.length > 128 ||
      (action === 'provider-webhook' ? principal.kind !== 'provider' :
        principal.kind === 'provider' || (action !== 'discovery' && principal.kind !== 'user'))) {
      throw new Error('A verified principal is required for this action.');
    }
    // Call ONLY after provider signature verification; never reject valid events
    // due to Redis. The webhook transaction still needs provider idempotency.
    if (action === 'provider-webhook') return { allowed: true, status: 200, state: 'bypassed', headers: {} };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        (async () => options.backend(action, principal, await options.identifier(principal)))(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Limiter deadline')), options.timeoutMs ?? 800); }),
      ]);
      // SDK resolves success:true on timeout; this is NOT an enforced allowance.
      reply.pending?.catch(() => {});
      if (reply.reason === 'timeout' || typeof reply.success !== 'boolean' ||
        !Number.isSafeInteger(reply.limit) || reply.limit < 1 || !Number.isSafeInteger(reply.remaining) || reply.remaining < 0 || reply.remaining > reply.limit ||
        !Number.isSafeInteger(reply.reset) || reply.reset < 0) throw new Error('Limiter unavailable');
      const headers: Record<string, string> = {
        'X-RateLimit-Limit': String(reply.limit), 'X-RateLimit-Remaining': String(reply.remaining),
        'X-RateLimit-Reset': String(Math.ceil(reply.reset / 1000)),
      };
      if (!reply.success) headers['Retry-After'] = String(Math.max(1, Math.ceil((reply.reset - (options.now?.() ?? Date.now())) / 1000)));
      return { allowed: reply.success, status: reply.success ? 200 : 429, state: 'enforced', headers };
    } catch {
      const allowed = RATE_POLICIES[action].outage === 'continue';
      return { allowed, status: allowed ? 200 : 503, state: 'degraded', headers: allowed ? {} : { 'Retry-After': '5' } };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/** Never accept a caller's first XFF entry. Trust is configured at deployment.
 * cloudflare: only behind the hosted ingress, after H02 spoof-header smoke tests.
 * unknown: all guests share one bucket; local/unverified ingress defaults here.
 */
export function guestSource(headers: Headers, source: 'cloudflare' | 'unknown'): string {
  if (source !== 'cloudflare') return 'unknown';
  const raw = headers.get('cf-connecting-ip');
  if (!raw || raw.length > 45 || /[\s,\[\]%/]/.test(raw)) return 'unknown';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) {
    const parts = raw.split('.');
    if (parts.some((part) => Number(part) > 255 || String(Number(part)) !== part)) return 'unknown';
    return parts.join('.');
  }
  if (!raw.includes(':') || !/^[0-9a-f:.]+$/i.test(raw)) return 'unknown';
  try { return new URL(`http://[${raw}]/`).hostname.toLowerCase(); } catch { return 'unknown'; }
}
