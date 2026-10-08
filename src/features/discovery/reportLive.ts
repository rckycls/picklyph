import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { getSupabase } from '@/lib/supabase';

import type { OwnerHttpTransport } from '../owner/venueClient';

/** Transport for the venue-reports function; the bearer must still belong to the account that opened the screen. */
export function reportTransport(actor: string): OwnerHttpTransport {
  const client = getSupabase(); const url = process.env.EXPO_PUBLIC_SUPABASE_URL!.trim();
  return { endpoint: `${url}/functions/v1/venue-reports`, apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(),
    accessToken: async () => {
      const { data, error } = await client.auth.getSession();
      return !error && data.session?.user.id === actor ? data.session.access_token : null;
    }, fetch: fetchWithDeadline };
}
