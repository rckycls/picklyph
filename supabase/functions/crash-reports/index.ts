import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { buildUpstashGuard } from '../_shared/upstash.ts';
import { guestSource } from '../_shared/rate-limit.ts';
import { createSupabaseCrashDeps } from './deps.ts';
import { createCrashReportHandler } from './handler.ts';
import { createSignalReporter, observeGuard, observeHandler, supabaseSignalWriter } from '../_shared/ops.ts';
const env = (name: string) => Deno.env.get(name);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) })) as typeof fetch } };
// The service client never inherits any caller headers or session; reports are anonymous.
const server = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_SECRET_KEY') ?? '', options);
// T51a: 5xx answers and rate-limiter outages feed the ops monitor (docs/monitoring.md).
const note = createSignalReporter('crash-reports', supabaseSignalWriter(server));
const guard = observeGuard(buildUpstashGuard(env), note);
Deno.serve(observeHandler(createCrashReportHandler({ ...createSupabaseCrashDeps(server),
  guestSource: (headers) => guestSource(headers, env('DISCOVERY_IP_SOURCE') === 'cloudflare' ? 'cloudflare' : 'unknown'),
  limit: (action, principal) => guard(action, principal) }), note));
