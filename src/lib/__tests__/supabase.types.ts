import type { AccountAccess, CourtStatus, Database, VenueMapPin } from '@picklyph/domain';
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

export async function checkAuthorizationTypes(client: SupabaseClient<Database>) {
  const profile = await client.from('profiles').select('id,display_name');
  const accessResult = await client.rpc('my_account_access');
  const access: AccountAccess[] | null = accessResult.data;
  client.from('profiles').update({ display_name: 'Court player' });
  // @ts-expect-error Profile display data cannot contain a privileged role.
  client.from('profiles').update({ role: 'admin' });
  // @ts-expect-error Owner is venue-specific, not an assignable global role.
  client.rpc('set_account_role', { actor_user_id: 'actor', target_user_id: 'target', assigned_role: 'owner', enabled: true });
  // @ts-expect-error Role assignments are not an exposed mobile table.
  client.from('account_roles');
  // @ts-expect-error Ownership records are not an exposed mobile table.
  client.from('venue_owners');
  // @ts-expect-error Self access does not accept a target user.
  client.rpc('my_account_access', { user_id: 'someone-else' });
  return { profile: profile.data, access };
}
