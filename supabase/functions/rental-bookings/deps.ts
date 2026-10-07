import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { RentalCommand, RentalQuery } from '../../../packages/domain/src/rentalBooking.ts';
import { RENTAL_STATUS, RentalRejected } from './handler.ts';
function rejected(error: { code?: string; hint?: string | null } | null): never {
  if (error?.hint && RENTAL_STATUS[error.hint]) throw new RentalRejected(error.hint);
  throw new Error('Rental command unavailable');
}
export function createSupabaseRentalDeps(verifier: () => SupabaseClient<Database>, server: () => SupabaseClient<Database>) {
  return {
    verifyUser: async (token: string): Promise<string | null> => {
      const { data, error } = await verifier().auth.getUser(token);
      if (error) {
        if ([400, 401, 403].includes(error.status ?? 0)) return null;
        throw new Error('Auth unavailable');
      }
      return data.user?.id ?? null;
    },
    read: async (actor: string, query: RentalQuery) => {
      if (query.section === 'quote') {
        const { data, error } = await server().rpc('rental_booking_quote', { actor_user_id: actor, target_court_id: query.court_id, starts: query.starts_at, ends: query.ends_at });
        if (error || !data) return rejected(error);
        return { quote: data };
      }
      const { data, error } = await server().rpc('rental_booking_read', { actor_user_id: actor,
        target_booking_id: query.section === 'booking' ? query.booking_id : null,
        target_venue_id: query.section === 'requests' ? query.venue_id : null,
        after_id: query.section === 'history' || query.section === 'requests' ? query.after_id : null });
      if (error || !data) return rejected(error);
      return data;
    },
    command: async (actor: string, command: RentalCommand) => {
      if (command.kind === 'request') {
        const { data, error } = await server().rpc('rental_booking_request', { actor_user_id: actor, target_court_id: command.court_id,
          request_id: command.request_id, starts: command.starts_at, ends: command.ends_at, expected_quote: command.expected_quote });
        if (error || !data) return rejected(error);
        return data;
      }
      const { data, error } = await server().rpc('rental_booking_change', { actor_user_id: actor, target_booking_id: command.booking_id, command: command.kind });
      if (error || !data) return rejected(error);
      return data;
    },
  };
}
