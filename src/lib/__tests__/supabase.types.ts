import type { CourtStatus, Database, VenueMapPin } from '@picklyph/domain';
import type { SupabaseClient } from '@supabase/supabase-js';

// Compile-only contract checks; this module is never imported by the app.
export async function checkDirectoryTypes(client: SupabaseClient<Database>) {
  const pinsResult = await client.rpc('venues_in_bounds', { south: 4, west: 116, north: 22, east: 127 });
  const pins: VenueMapPin[] | null = pinsResult.data;
  const courtsResult = await client.from('courts').select('id,name,venue_id,status');
  const statuses: CourtStatus[] = courtsResult.data?.map((court) => court.status) ?? [];

  // @ts-expect-error Map bounds require all four coordinates.
  client.rpc('venues_in_bounds', { south: 4, west: 116, north: 22 });
  // @ts-expect-error Evidence is not part of the public mobile database contract.
  client.from('venue_claims');
  // @ts-expect-error Private schemas cannot be selected by this mobile client.
  client.schema('private');
  return { pins, statuses };
}
