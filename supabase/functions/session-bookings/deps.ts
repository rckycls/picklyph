import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { SessionBookingCommand, SessionBookingQuery } from '../../../packages/domain/src/sessionBooking.ts';
import { SESSION_BOOKING_STATUS, SessionBookingRejected } from './handler.ts';
function rejected(error: { code?: string; hint?: string | null } | null): never {
  if (error?.hint && SESSION_BOOKING_STATUS[error.hint]) throw new SessionBookingRejected(error.hint);
  throw new Error('Session booking unavailable');
}
export function createSupabaseSessionBookingDeps(verifier: () => SupabaseClient<Database>, server: () => SupabaseClient<Database>) {
  return {
    verifyUser: async (token: string): Promise<string | null> => {
      const { data, error } = await verifier().auth.getUser(token);
      if (error) {
        if ([400, 401, 403].includes(error.status ?? 0)) return null;
        throw new Error('Auth unavailable');
      }
      return data.user?.id ?? null;
    },
    read: async (actor: string, query: SessionBookingQuery) => {
      const target = query.section === 'sessions' || query.section === 'requests' ? query.venue_id
        : query.section === 'session' || query.section === 'walk_ins' ? query.session_id : query.section === 'booking' ? query.booking_id : null;
      const after = query.section === 'session' || query.section === 'booking' ? null : query.after_id;
      const { data, error } = await server().rpc('session_booking_read', { actor_user_id: actor, section: query.section, target_id: target, after_id: after });
      if (error || !data) return rejected(error);
      return data;
    },
    command: async (actor: string, command: SessionBookingCommand) => {
      if (command.kind === 'request' || command.kind === 'walk_in') {
        const input = { session_id: command.session_id, request_id: command.request_id, participants: command.participants,
          expected_total_centavos: command.expected_total_centavos };
        const { data, error } = command.kind === 'request'
          ? await server().rpc('session_booking_request', { actor_user_id: actor, booking_input: input })
          : await server().rpc('session_walk_in', { actor_user_id: actor, walk_in_input: input });
        if (error || !data) return rejected(error);
        return data;
      }
      const { data, error } = await server().rpc('session_booking_change', { actor_user_id: actor, target_booking_id: command.booking_id, command: command.kind });
      if (error || !data) return rejected(error);
      return data;
    },
  };
}
