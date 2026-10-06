import 'server-only';
import type { ReviewCursor } from '@picklyph/domain';
import { createAdminClient } from './supabase';
import { readConsoleAccess, type ConsoleAccess } from './access';
import { createDirectoryServiceClient } from './directory-server';

/** Admins and moderators. Every data-bearing page and route verifies independently. */
export async function readReviewAccess(): Promise<ConsoleAccess> {
  try { return await readConsoleAccess(await createAdminClient(), 'moderator'); }
  catch { return { status: 'unavailable' }; }
}

export async function readOwnershipQueue(actorId: string, after: ReviewCursor | null) {
  const { data, error } = await createDirectoryServiceClient().rpc('ownership_review_queue', {
    actor_user_id: actorId, after_created_at: after?.created_at ?? null, after_id: after?.id ?? null,
  });
  if (error || !data) throw new Error('Review queue is unavailable.');
  return data;
}

/** Null when the item does not exist. */
export async function readOwnershipReview(actorId: string, subjectId: string) {
  const { data, error } = await createDirectoryServiceClient().rpc('ownership_review_read', { actor_user_id: actorId, subject_id: subjectId });
  if (error?.hint === 'not_found') return null;
  if (error || !data) throw new Error('Review item is unavailable.');
  return data;
}
