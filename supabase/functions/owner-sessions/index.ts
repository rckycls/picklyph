import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { buildUpstashGuard } from '../_shared/upstash.ts';
import { createSupabaseSessionDeps } from './deps.ts';
import { createSessionHandler } from './handler.ts';

const env = (name: string) => Deno.env.get(name);
const guard = buildUpstashGuard(env);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) })) as typeof fetch } };
// Never copy request Authorization into the isolated service client.
const verifier = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_PUBLISHABLE_KEY') ?? '', options);
const server = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_SECRET_KEY') ?? '', options);
Deno.serve(createSessionHandler({ ...createSupabaseSessionDeps(verifier,server), limit: (action,principal) => guard(action,principal) }));
