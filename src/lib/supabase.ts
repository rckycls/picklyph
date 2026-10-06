import 'react-native-url-polyfill/auto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@picklyph/domain';

import { sessionStorage } from '@/features/auth/sessionStorage';
import { fetchWithDeadline } from './fetchWithDeadline';

let client: SupabaseClient<Database> | undefined;
let sessionKey: string | undefined;

/** Lazy public client; native sessions use device-only secure storage. */
export function getSupabase(): SupabaseClient<Database> {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)
      || /YOUR_|REPLACE_WITH_/i.test(url)
      || !key || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('Configure the staging Supabase URL and publishable key in your local mobile environment.');
  }
  sessionKey = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
  client = createClient<Database>(url, key, {
    global: { fetch: fetchWithDeadline },
    auth: {
      storage: sessionStorage,
      storageKey: sessionKey,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}

/** Recovery for unreadable persistence; ordinary sign-out uses the SDK. */
export async function clearSavedSession() {
  await getSupabase().auth.stopAutoRefresh();
  if (sessionKey) {
    await sessionStorage.removeItem(sessionKey);
    await sessionStorage.removeItem(`${sessionKey}-user`);
  }
  const { error } = await getSupabase().auth.signOut({ scope: 'local' });
  if (error) throw new Error('We couldn’t clear the saved sign-in. Please try again.');
}
