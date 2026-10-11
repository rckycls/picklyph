import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { buildUpstashGuard } from '../_shared/upstash.ts';
import { createSupabaseScheduleDeps } from './deps.ts';
import { createScheduleHandler } from './handler.ts';
import { createSignalReporter, observeGuard, observeHandler, supabaseSignalWriter } from '../_shared/ops.ts';

const env = (name: string) => Deno.env.get(name);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) })) as typeof fetch } };
// Never copy request Authorization into the isolated service client.
const verifier = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_PUBLISHABLE_KEY') ?? '', options);
const server = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_SECRET_KEY') ?? '', options);
// T51a: 5xx answers and rate-limiter outages feed the ops monitor (docs/monitoring.md).
const note = createSignalReporter('owner-schedules', supabaseSignalWriter(server));
const guard = observeGuard(buildUpstashGuard(env), note);
Deno.serve(observeHandler(createScheduleHandler({ ...createSupabaseScheduleDeps(verifier,server), limit: (action,principal) => guard(action,principal) }), note));
