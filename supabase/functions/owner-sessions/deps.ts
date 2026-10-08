import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { SessionCommand, SessionQuery } from '../../../packages/domain/src/session.ts';
import { SessionRejected, SESSION_STATUS } from './handler.ts';

function rejected(error: { code?: string; hint?: string | null } | null): never {
  if (error?.hint && SESSION_STATUS[error.hint]) throw new SessionRejected(error.hint);
  if (error?.code === '42501') throw new SessionRejected('not_owner');
  throw new Error('Session command unavailable');
}
export function createSupabaseSessionDeps(verifier: () => SupabaseClient<Database>, server: () => SupabaseClient<Database>) {
  return {
    verifyUser: async (token: string): Promise<string | null> => {
      const { data, error } = await verifier().auth.getUser(token);
      if (error) {
        if ([400, 401, 403].includes(error.status ?? 0)) return null;
        throw new Error('Auth unavailable');
      }
      return data.user?.id ?? null;
    },
    read: async (actor: string, query: SessionQuery) => {
      const { data, error } = await server().rpc('owner_session_read', { actor_user_id: actor, target_venue_id: query.venue_id, after_id: query.after_id });
      if (error || !data) return rejected(error);
      return data;
    },
    command: async (actor: string, command: SessionCommand) => {
      const { data, error } = command.kind === 'create'
        ? await server().rpc('owner_session_create', { actor_user_id: actor, session_input: command.command })
        : await server().rpc('owner_session_cancel', { actor_user_id: actor, target_session_id: command.session_id });
      if (error || !data) return rejected(error);
      return data;
    },
  };
}
