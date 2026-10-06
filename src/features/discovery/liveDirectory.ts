import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { getSupabase } from '@/lib/supabase';

import { searchVenues, type DiscoveryQuery, type SearchOutcome, type SearchTransport } from './searchClient';
import { loadVenueDetail, type VenueDetail } from './venueDetail';

let transport: SearchTransport | null | undefined;

/** Public URL/key only; the endpoint holds every server secret. Null when this build lacks Supabase config. */
function liveTransport(): SearchTransport | null {
  if (transport !== undefined) return transport;
  try {
    const client = getSupabase(); // Validates the public staging URL/key pair.
    transport = {
      endpoint: `${process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? ''}/functions/v1/venue-search`,
      apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '',
      accessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
      fetch: fetchWithDeadline,
    };
  } catch {
    transport = null;
  }
  return transport;
}

export async function searchLiveVenues(query: DiscoveryQuery, after: string | null, signal: AbortSignal): Promise<SearchOutcome> {
  const live = liveTransport();
  if (!live) return { ok: false, failure: { kind: 'not_configured', retryAfterSeconds: null } };
  return searchVenues(live, query, { after, signal });
}

export async function loadLiveVenueDetail(id: string, signal: AbortSignal): Promise<VenueDetail | null> {
  return loadVenueDetail(getSupabase(), id, signal);
}
