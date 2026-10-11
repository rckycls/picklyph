import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { createAppleRevocation, readAppleConfig } from '../_shared/apple.ts';
import { buildUpstashGuard } from '../_shared/upstash.ts';
import { createSupabaseAccountDeletionDeps } from './deps.ts';
import { createAccountDeletionHandler } from './handler.ts';
import { createSignalReporter, observeGuard, observeHandler, supabaseSignalWriter } from '../_shared/ops.ts';
const env = (name: string) => Deno.env.get(name);
const deadline = ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) })) as typeof fetch;
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: deadline } };
const verifier = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_PUBLISHABLE_KEY') ?? '', options);
// The service client never inherits any caller headers or session.
const server = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_SECRET_KEY') ?? '', options);
// T51a: 5xx answers and rate-limiter outages feed the ops monitor (docs/monitoring.md).
const note = createSignalReporter('account-deletion', supabaseSignalWriter(server));
const guard = observeGuard(buildUpstashGuard(env), note);
// T50a: APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_CLIENT_ID and APPLE_PRIVATE_KEY; without all four, Apple-linked accounts get 503 apple_unavailable.
const appleConfig = readAppleConfig(env);
const apple = appleConfig ? createAppleRevocation(appleConfig, deadline) : null;
Deno.serve(observeHandler(createAccountDeletionHandler({ ...createSupabaseAccountDeletionDeps(verifier, server), apple, limit: (action, principal) => guard(action, principal) }), note));
