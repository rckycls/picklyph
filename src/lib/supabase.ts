import 'react-native-url-polyfill/auto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@picklyph/domain';

let client: SupabaseClient<Database> | undefined;

/** Lazy public directory client. Auth persistence/lifecycle is added in T07. */
export function getSupabase(): SupabaseClient<Database> {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)
      || /YOUR_|REPLACE_WITH_/i.test(url)
      || !key || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('Configure the staging Supabase URL and publishable key in your local mobile environment.');
  }
  client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}
