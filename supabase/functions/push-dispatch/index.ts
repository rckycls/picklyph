import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { createSupabasePushDispatchDeps } from './deps.ts';
import { createExpoPush } from './expo.ts';
import { createPushDispatchHandler } from './handler.ts';
const env = (name: string) => Deno.env.get(name);
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8000) })) as typeof fetch } };
// The worker only needs the service client; it never sees a user token.
const server = () => createClient<Database>(env('DISCOVERY_SUPABASE_URL') ?? '', env('DISCOVERY_SUPABASE_SECRET_KEY') ?? '', options);
// EXPO_ACCESS_TOKEN is optional (Expo "enhanced push security"); when set, Expo rejects sends without it.
const expo = createExpoPush(((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10000) })) as typeof fetch,
  env('EXPO_ACCESS_TOKEN') || undefined);
Deno.serve(createPushDispatchHandler({ secret: env('PUSH_WORKER_SECRET'), ...createSupabasePushDispatchDeps(server), send: expo.send, receipts: expo.receipts }));
