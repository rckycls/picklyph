import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { buildUpstashGuard } from '../_shared/upstash.ts';
import { createSupabaseVenueDeps } from './deps.ts';
import { createVenueHandler } from './handler.ts';

const env = (name: string) => Deno.env.get(name);
const guard = buildUpstashGuard(env);
// Shares the T13 server credentials (same project; function secrets are project-wide).
const supabaseUrl = env('DISCOVERY_SUPABASE_URL') ?? '';
const publicKey = env('DISCOVERY_SUPABASE_PUBLISHABLE_KEY') ?? '';
const secretKey = env('DISCOVERY_SUPABASE_SECRET_KEY') ?? '';
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) });
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: timedFetch } };
// Lazy initialization lets a missing configuration return a sanitized 503.
const verifier = () => createClient<Database>(supabaseUrl, publicKey, options);
const server = () => createClient<Database>(supabaseUrl, secretKey, options);

const lastWarning = new Map<string, number>();
Deno.serve(createVenueHandler({
  ...createSupabaseVenueDeps(verifier, server),
  limit: (action, principal) => guard(action, principal),
  newId: () => crypto.randomUUID(),
  warn: (event) => {
    if (Date.now() - (lastWarning.get(event) ?? 0) > 60000) {
      console.warn(`owner-venues: ${event}`);
      lastWarning.set(event, Date.now());
    }
  },
}));
