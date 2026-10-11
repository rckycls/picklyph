import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { readUpstashConfig } from '../_shared/upstash.ts';
import { createDiscordPoster, createHeartbeat, createSupabaseOpsDeps } from './deps.ts';
import { createOpsMonitorHandler } from './handler.ts';
import { createUpstashProbe } from './redis.ts';
const env = (name: string) => Deno.env.get(name);
const deadline = (ms: number) => ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: deadline(8000) } };
// The monitor only needs the service client; it never sees a user token.
const server = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_SECRET_KEY') ?? '', options);
Deno.serve(createOpsMonitorHandler({
  secret: env('OPS_MONITOR_SECRET'), environment: env('PICKLY_ENV'), webhook: env('OPS_ALERT_WEBHOOK_URL'),
  heartbeat: env('OPS_HEARTBEAT_URL') || undefined, redis: createUpstashProbe(readUpstashConfig(env)),
  ...createSupabaseOpsDeps(server), post: createDiscordPoster(deadline(10000)), ping: createHeartbeat(deadline(5000)),
}));
