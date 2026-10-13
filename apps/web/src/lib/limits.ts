// Fixed-window request limits in Upstash Redis over its REST API (one atomic /multi-exec per check).
// Identifiers are HMAC-SHA256 of the principal under a private salt, so Redis never sees an IP or email.
// Any error, timeout or odd reply throws LimiterUnavailable: registration fails closed (503, no write).

export type LimitAction = 'prelaunch-lookup' | 'prelaunch-register';
export type LimitKind = 'ip' | 'email';
export type LimitDecision = { allowed: true } | { allowed: false; retryAfter: number };
export type LimiterSettings = { environment: string; url: string; token: string; salt: string };
export type Limiter = (action: LimitAction, kind: LimitKind, id: string) => Promise<LimitDecision>;

/** Without Vercel's client IP header every visitor shares one bucket with the same limit. */
export const PRELAUNCH_LIMITS: Record<LimitAction, Partial<Record<LimitKind, { max: number; windowSeconds: number }>>> = {
  // Address search is a paid Geocoding call.
  'prelaunch-lookup': { ip: { max: 30, windowSeconds: 60 } },
  'prelaunch-register': { ip: { max: 10, windowSeconds: 600 }, email: { max: 10, windowSeconds: 3600 } },
};

export class LimiterUnavailable extends Error {
  constructor() { super('Limiter unavailable'); this.name = 'LimiterUnavailable'; }
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const integer = (item: unknown): number | null => {
  const result = (item as { result?: unknown } | null)?.result;
  return typeof result === 'number' && Number.isSafeInteger(result) ? result : null;
};

export function createLimiter(settings: LimiterSettings | null, fetcher: typeof fetch = fetch, timeoutMs = 800): Limiter {
  return async (action, kind, id) => {
    const policy = PRELAUNCH_LIMITS[action][kind];
    if (!policy || !id || id.length > 320) throw new Error('Unknown limit.');
    if (!settings) throw new LimiterUnavailable();
    try {
      const key = `pickly:${settings.environment}:${action}:${kind}:${await hmacHex(settings.salt, `${kind}:${id}`)}`;
      const response = await fetcher(`${settings.url}/multi-exec`, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([['SET', key, '0', 'PX', String(policy.windowSeconds * 1000), 'NX'], ['INCR', key], ['PTTL', key]]),
      });
      if (!response.ok) throw new LimiterUnavailable();
      const body: unknown = await response.json();
      const count = Array.isArray(body) && body.length === 3 ? integer(body[1]) : null;
      const ttl = Array.isArray(body) ? integer(body[2]) : null;
      if (count === null || count < 1 || ttl === null) throw new LimiterUnavailable();
      if (count <= policy.max) return { allowed: true };
      return { allowed: false, retryAfter: ttl > 0 ? Math.ceil(ttl / 1000) : policy.windowSeconds };
    } catch {
      throw new LimiterUnavailable();
    }
  };
}
