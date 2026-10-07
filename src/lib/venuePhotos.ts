import { getSupabase } from './supabase';

/** Only server-created paths from the public photo rows; no private evidence URLs. */
export function venuePhotoUrl(storagePath: string): string {
  return getSupabase().storage.from('venue-photos').getPublicUrl(storagePath).data.publicUrl;
}
