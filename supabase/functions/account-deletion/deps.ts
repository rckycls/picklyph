import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { DELETION_STATUS, DeletionRejected, type DELETION_BUCKETS, type VerifiedCaller } from './handler.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Read only after Auth has verified the token; never trusted on its own.
function subject(token: string): string | null {
  try {
    const part = token.split('.')[1] ?? '';
    const json = new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && UUID.test(sub) ? sub.toLowerCase() : null;
  } catch { return null; }
}
export function createSupabaseAccountDeletionDeps(verifier: () => SupabaseClient<Database>, server: () => SupabaseClient<Database>) {
  return {
    verifyUser: async (token: string): Promise<VerifiedCaller> => {
      const { data, error } = await verifier().auth.getUser(token);
      if (error) {
        // Auth checks the signature before looking the account up, so this code means a genuine token whose account is gone.
        if (error.status === 403 && error.code === 'user_not_found') {
          const id = subject(token);
          return id ? { kind: 'missing', id } : null;
        }
        if ([400, 401, 403].includes(error.status ?? 0)) return null;
        throw new Error('Auth unavailable');
      }
      return data.user ? { kind: 'user', id: data.user.id } : null;
    },
    begin: async (actor: string) => {
      const { data, error } = await server().rpc('account_deletion_begin', { actor_user_id: actor });
      if (error?.hint && DELETION_STATUS[error.hint]) throw new DeletionRejected(error.hint);
      if (error || !data) throw new Error('Deletion unavailable');
      return data;
    },
    status: async (user: string) => {
      const { data, error } = await server().rpc('account_deletion_status', { target_user_id: user });
      if (error || (data !== 'none' && data !== 'pending' && data !== 'deleted')) throw new Error('Deletion unavailable');
      return data;
    },
    // Avatars and owner evidence live under `<account id>/`, including uploads whose commit was uncertain.
    removeFolder: async (bucket: typeof DELETION_BUCKETS[number], folder: string) => {
      const storage = server().storage.from(bucket);
      for (let round = 0; round < 50; round++) {
        const { data, error } = await storage.list(folder, { limit: 100 });
        if (error || !data) throw new Error('Storage unavailable');
        if (data.length === 0) return;
        const { error: removal } = await storage.remove(data.map((item) => `${folder}/${item.name}`));
        if (removal) throw new Error('Storage unavailable');
      }
      throw new Error('Storage folder not emptied');
    },
    deleteUser: async (actor: string) => {
      const { error } = await server().auth.admin.deleteUser(actor);
      // A concurrent retry may have finished first.
      if (error && error.status !== 404) throw new Error('Auth unavailable');
    },
  };
}
