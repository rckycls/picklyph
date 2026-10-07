import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { OwnerPhotoAdd, OwnerPhotoRemove, OwnerVenueSave, PhotoType } from '../../../packages/domain/src/ownerVenues.ts';
import { CommandRejected, REJECTIONS } from './handler.ts';

function rejected(error: { hint?: string | null } | null): never {
  if (error?.hint && REJECTIONS[error.hint]) throw new CommandRejected(error.hint);
  throw new Error('Owner venue command unavailable');
}

/**
 * Supabase-backed handler dependencies. `verifier` holds only the public key and
 * verifies user tokens; `server` is a stateless service client that never sees
 * caller Authorization. Shared by the Edge entry point and local integration tests.
 */
export function createSupabaseVenueDeps(verifier: () => SupabaseClient<Database>, server: () => SupabaseClient<Database>) {
  const photos = () => server().storage.from('venue-photos');
  return {
    verifyUser: async (token: string): Promise<string | null> => {
      const { data, error } = await verifier().auth.getUser(token);
      if (error) {
        if (error.status === 400 || error.status === 401 || error.status === 403) return null;
        throw new Error('Auth unavailable');
      }
      return data.user?.id ?? null;
    },
    list: async (actor: string) => {
      const { data, error } = await server().rpc('owner_venue_list', { actor_user_id: actor });
      if (error || !data) return rejected(error);
      return data;
    },
    read: async (actor: string, venueId: string) => {
      const { data, error } = await server().rpc('owner_venue_read', { actor_user_id: actor, target_venue_id: venueId });
      if (error || !data) return rejected(error);
      return data;
    },
    save: async (actor: string, command: OwnerVenueSave) => {
      const { data, error } = await server().rpc('owner_venue_save', { actor_user_id: actor, target_venue_id: command.venue_id,
        expected_updated_at: command.expected_updated_at, venue_input: command.venue, court_inputs: command.courts });
      if (error || !data) return rejected(error);
      return data;
    },
    // Short CDN lifetime: a removed photo stops being served within the hour.
    upload: async (path: string, bytes: Uint8Array, type: PhotoType): Promise<void> => {
      const { error } = await photos().upload(path, bytes, { contentType: type, upsert: false, cacheControl: '3600' });
      if (error) throw new Error('Photo storage unavailable');
    },
    remove: async (path: string): Promise<void> => {
      const { error } = await photos().remove([path]);
      if (error) throw new Error('Photo cleanup failed');
    },
    addPhoto: async (actor: string, request: OwnerPhotoAdd, path: string, width: number, height: number) => {
      const { data, error } = await server().rpc('owner_venue_photo_add', { actor_user_id: actor, target_venue_id: request.venue_id,
        photo_request_id: request.request_id, storage_ref: path, photo_width: width, photo_height: height });
      if (error || !data) return rejected(error);
      return data;
    },
    removePhoto: async (actor: string, command: OwnerPhotoRemove) => {
      const { data, error } = await server().rpc('owner_venue_photo_remove', { actor_user_id: actor,
        target_venue_id: command.venue_id, target_photo_id: command.photo_id });
      if (error || !data) return rejected(error);
      return data;
    },
  };
}
