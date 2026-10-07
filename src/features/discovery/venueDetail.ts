import type { Court, Database, OwnerVenuePhoto, Venue } from '@picklyph/domain';
import type { SupabaseClient } from '@supabase/supabase-js';

export type VenueDetail = Pick<Venue, 'id' | 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude' | 'claim_status'> & {
  courts: Pick<Court, 'id' | 'name' | 'surface' | 'is_indoor' | 'is_covered'>[];
  photos: OwnerVenuePhoto[];
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
  let photoQuery = client.from('venue_photos').select('id,storage_path,width,height,created_at')
    .eq('venue_id', id).order('created_at').order('id').limit(6);
  if (signal) {
    venueQuery = venueQuery.abortSignal(signal);
    courtQuery = courtQuery.abortSignal(signal);
    photoQuery = photoQuery.abortSignal(signal);
  }
  const [venue, courts, photos] = await Promise.all([venueQuery.maybeSingle(), courtQuery, photoQuery]);
  // During the T18 staging rollout the new table may not exist yet. Keep the
  // existing venue/court details usable; every other photo-query failure surfaces.
  const photosNotDeployed = photos.error?.code === 'PGRST205' || photos.error?.code === '42P01';
  if (venue.error || courts.error || (photos.error && !photosNotDeployed)) throw new Error('Venue details are unavailable.');
  if (!venue.data) return null;
  if (!Number.isFinite(venue.data.latitude) || !Number.isFinite(venue.data.longitude)) throw new Error('Venue details are unavailable.');
  return { ...venue.data, courts: courts.data, photos: photos.data ?? [] };
}
