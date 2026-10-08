import 'server-only';
import type { ReviewCursor } from '@picklyph/domain';
import { createDirectoryServiceClient } from './directory-server';

// Callers verify access first (readReviewAccess: admins and moderators); the database re-checks the role.
export async function readModerationQueue(actorId: string, after: ReviewCursor | null) {
  const { data, error } = await createDirectoryServiceClient().rpc('moderation_queue', {
    actor_user_id: actorId, after_created_at: after?.created_at ?? null, after_id: after?.id ?? null,
  });
  if (error || !data) throw new Error('Report queue is unavailable.');
  return data;
}

/** Null when the listing does not exist. */
export async function readModerationVenue(actorId: string, venueId: string) {
  const { data, error } = await createDirectoryServiceClient().rpc('moderation_venue_read', { actor_user_id: actorId, target_venue_id: venueId });
  if (error?.hint === 'not_found') return null;
  if (error || !data) throw new Error('Listing moderation is unavailable.');
  return data;
}
