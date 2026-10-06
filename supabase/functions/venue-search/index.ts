import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { buildUpstashGuard } from '../_shared/upstash.ts';
import { guestSource } from '../_shared/rate-limit.ts';
import { createSearchHandler } from './handler.ts';

const env = (name: string) => Deno.env.get(name);
const guard = buildUpstashGuard(env);
// Explicit custom names avoid platform-specific automatic/legacy key injection.
// The service client is stateless and never inherits caller Authorization.
const supabaseUrl = env('DISCOVERY_SUPABASE_URL') ?? '';
const publicKey = env('DISCOVERY_SUPABASE_PUBLISHABLE_KEY') ?? '';
const secretKey = env('DISCOVERY_SUPABASE_SECRET_KEY') ?? '';
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(4000) });
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: timedFetch } };
// Lazy initialization lets a missing configuration return a sanitized503.
const verifier = () => createClient<Database>(supabaseUrl, publicKey, options);
const server = () => createClient<Database>(supabaseUrl, secretKey, options);
let lastDegradedLog = 0;
Deno.serve(createSearchHandler({
  verifyUser: async (token) => {
    const { data, error } = await verifier().auth.getUser(token);
    if (error) {
      if (error.status === 400 || error.status === 401 || error.status === 403) return null;
      throw new Error('Auth unavailable');
    }
    return data.user?.id ?? null;
  },
  guestSource: (headers) => guestSource(headers, env('DISCOVERY_IP_SOURCE') === 'cloudflare' ? 'cloudflare' : 'unknown'),
  limit: (principal) => guard('discovery', principal),
  search: async (query) => {
    const { data, error } = await server().rpc('directory_search', { search: query });
    if (error || !data) throw new Error('Search unavailable');
    return data;
  },
  degraded: () => {
    if (Date.now() - lastDegradedLog > 60000) {
      console.warn('venue-search: rate limiter unavailable; bounded discovery continues');
      lastDegradedLog = Date.now();
    }
  },
}));
