import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { createSupabaseStorageSweepDeps } from './deps.ts';
import { createStorageSweepHandler } from './handler.ts';
import { createSignalReporter, observeHandler, supabaseSignalWriter } from '../_shared/ops.ts';
const env = (name: string) => Deno.env.get(name);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20000) })) as typeof fetch } };
// The worker only needs the service client; it never sees a user token.
const server = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_SECRET_KEY') ?? '', options);
// T51a: 5xx answers feed the ops monitor (docs/monitoring.md).
const note = createSignalReporter('storage-sweep', supabaseSignalWriter(server));
Deno.serve(observeHandler(createStorageSweepHandler({ secret: env('STORAGE_SWEEP_SECRET'), ...createSupabaseStorageSweepDeps(server) }), note));
