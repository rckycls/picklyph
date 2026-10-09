import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { clearAccountRecovery } from '@/lib/recoveryKeys';
import { getSupabase } from '@/lib/supabase';

import { attemptStore } from '../rental/attemptStore';
import type { OwnerHttpTransport } from '../owner/venueClient';

/** Transport for the account-deletion function; the bearer must still belong to the account that opened the screen. */
export function accountDeletionServices(actor: string): { transport: OwnerHttpTransport; clearDevice: () => Promise<void> } {
  const client = getSupabase(); const url = process.env.EXPO_PUBLIC_SUPABASE_URL!.trim();
  return {
    transport: { endpoint: `${url}/functions/v1/account-deletion`, apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(),
      accessToken: async () => {
        const { data, error } = await client.auth.getSession();
        return !error && data.session?.user.id === actor ? data.session.access_token : null;
      }, fetch: fetchWithDeadline },
    clearDevice: () => clearAccountRecovery(attemptStore, url, actor),
  };
}
