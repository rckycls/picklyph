import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { createRateGuard, RATE_POLICIES, type RateAction, type RatePrincipal } from './rate-limit.ts';

export function buildUpstashGuard(env: (name: string) => string | undefined) {
  const environment = env('PICKLY_ENV');
  const url = env('UPSTASH_REDIS_REST_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN');
  const salt = env('RATE_LIMIT_KEY_SECRET');
  let redis: Redis | null = null;
  let key: Promise<CryptoKey> | null = null;
  try {
    const endpoint = new URL(url ?? '');
    if (!['local', 'staging', 'production'].includes(environment ?? '') ||
      endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.upstash.io') || endpoint.username || endpoint.password ||
      endpoint.port || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !token || !salt || salt.length < 32) throw new Error('Configuration');
    redis = new Redis({ url: endpoint.origin, token, retry: false });
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } catch { /* Missing/bad config follows the same explicit outage policy. */ }
  const limiters = new Map<string, Ratelimit>();
  return createRateGuard({
    identifier: async (principal) => {
      if (!key) throw new Error('Limiter unavailable');
      const signature = await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(`${principal.kind}:${principal.id}`));
      return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
    },
    backend: async (action: RateAction, principal: RatePrincipal, identifier: string) => {
      if (!redis || principal.kind === 'provider') throw new Error('Limiter unavailable');
      const namespace = `pickly:${environment}:${action}:${principal.kind}`;
      let limiter = limiters.get(namespace);
      if (!limiter) {
        limiter = new Ratelimit({ redis, prefix: namespace,
          limiter: Ratelimit.slidingWindow(RATE_POLICIES[action][principal.kind], '60 s'),
          timeout: 650, analytics: false, ephemeralCache: false });
        limiters.set(namespace, limiter);
      }
      return await limiter.limit(identifier);
    },
  });
}
