import type { Court, Database, Venue } from '@picklyph/domain';
import type { SupabaseClient } from '@supabase/supabase-js';

export type VenueDetail = Pick<Venue, 'id' | 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude' | 'claim_status'> & {
  courts: Pick<Court, 'id' | 'name' | 'surface' | 'is_indoor' | 'is_covered'>[];
};

// Mirrors MAX_DIRECTORY_COURTS without a runtime domain import, keeping this module Node-loadable.
const MAX_COURTS = 50;

/**
 * Current public record through T05 RLS: approved venues and their active courts only.
 * Null means the venue is no longer listed (suspended, unpublished or removed).
 */
export async function loadVenueDetail(client: SupabaseClient<Database>, id: string, signal?: AbortSignal): Promise<VenueDetail | null> {
  let venueQuery = client.from('venues').select('id,name,address_line,city,province,latitude,longitude,claim_status').eq('id', id);
  let courtQuery = client.from('courts').select('id,name,surface,is_indoor,is_covered')
    .eq('venue_id', id).eq('status', 'active').order('name').limit(MAX_COURTS);
  if (signal) {
    venueQuery = venueQuery.abortSignal(signal);
    courtQuery = courtQuery.abortSignal(signal);
  }
  const [venue, courts] = await Promise.all([venueQuery.maybeSingle(), courtQuery]);
  if (venue.error || courts.error) throw new Error('Venue details are unavailable.');
  if (!venue.data) return null;
  if (!Number.isFinite(venue.data.latitude) || !Number.isFinite(venue.data.longitude)) throw new Error('Venue details are unavailable.');
  return { ...venue.data, courts: courts.data };
}
