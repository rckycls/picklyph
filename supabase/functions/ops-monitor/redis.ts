import { Redis } from '@upstash/redis';
import type { UpstashConfig } from '../_shared/upstash.ts';
import type { RedisProbe } from './handler.ts';

/** The monitor's Redis calls, with the same settings the rate guard uses. Null without valid settings. */
export function createUpstashProbe(config: UpstashConfig | null): RedisProbe | null {
  if (!config) return null;
  const redis = new Redis({ url: config.url, token: config.token, retry: false });
  return {
    ping: () => redis.ping(),
    mark: (key, value, seconds) => redis.set(key, value, { ex: seconds }),
    exists: (keys) => redis.exists(...keys),
  };
}
