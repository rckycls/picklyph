import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { OwnerDuplicate, OwnerSubmissionRequest, OwnerSubmitResult, EvidenceType } from '../../../packages/domain/src/owner.ts';
import { CommandRejected, REJECTIONS } from './handler.ts';

function rejected(error: { hint?: string | null } | null): never {
  if (error?.hint && REJECTIONS[error.hint]) throw new CommandRejected(error.hint);
  throw new Error('Owner command unavailable');
}

/**
 * Supabase-backed handler dependencies. `verifier` holds only the public key and
 * verifies user tokens; `server` is a stateless service client that never sees
 * caller Authorization. Shared by the Edge entry point and local integration tests.
 */
export function createSupabaseOwnerDeps(verifier: () => SupabaseClient<Database>, server: () => SupabaseClient<Database>) {
  const evidence = () => server().storage.from('owner-evidence');
  return {
    verifyUser: async (token: string): Promise<string | null> => {
      const { data, error } = await verifier().auth.getUser(token);
      if (error) {
        if (error.status === 400 || error.status === 401 || error.status === 403) return null;
        throw new Error('Auth unavailable');
      }
      return data.user?.id ?? null;
    },
    nearby: async (actor: string, latitude: number, longitude: number, name: string | null): Promise<OwnerDuplicate[]> => {
      const { data, error } = await server().rpc('owner_duplicate_candidates',
        { actor_user_id: actor, latitude, longitude, proposed_name: name });
      if (error || !data) return rejected(error);
      return data;
    },
    upload: async (path: string, bytes: Uint8Array, type: EvidenceType): Promise<void> => {
      const { error } = await evidence().upload(path, bytes, { contentType: type, upsert: false, cacheControl: '0' });
      if (error) throw new Error('Evidence storage unavailable');
    },
    remove: async (path: string): Promise<void> => {
      const { error } = await evidence().remove([path]);
      if (error) throw new Error('Evidence cleanup failed');
    },
    submit: async (actor: string, request: OwnerSubmissionRequest, path: string): Promise<OwnerSubmitResult> => {
      const { data, error } = request.kind === 'claim'
        ? await server().rpc('owner_submit_claim', { actor_user_id: actor, submission_request_id: request.request_id,
          target_venue_id: request.venue_id, evidence_ref: path, claim_note: request.note })
        : await server().rpc('owner_submit_venue', { actor_user_id: actor, submission_request_id: request.request_id,
          venue_input: request.venue, evidence_ref: path, submission_note: request.note,
          acknowledge_duplicates: request.acknowledge_duplicates });
      if (error || !data) return rejected(error);
      return data;
    },
  };
}
