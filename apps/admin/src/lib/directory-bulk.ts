import type { DirectoryBulkAction, DirectoryBulkOutcome } from '@picklyph/domain';

type RpcError = { code?: string | null; hint?: string | null; details?: string | null };

/** What `directory_admin_delete` found (its error detail), in the reviewer's words. */
const HISTORY: Record<string, string> = {
  court_history: 'court bookings or blocks', session_history: 'open-play sessions', cancellations: 'venue cancellations',
  owner: 'an owner', claim: 'an ownership claim', submission: 'an owner submission', photos: 'photos',
  reports: 'reports or moderation history', merchant: 'payment settings',
};

/** One listing's outcome in a bulk action. A delete of a listing that is already gone counts as done (a retry). */
export function bulkOutcome(action: DirectoryBulkAction, id: string, error: RpcError | null): DirectoryBulkOutcome {
  if (!error) return { id, done: true, message: null };
  if (action === 'delete' && error.code === 'P0002') return { id, done: true, message: 'Already deleted.' };
  return { id, done: false, message: bulkFailureMessage(action, error) };
}

export function bulkFailureMessage(action: DirectoryBulkAction, error: RpcError): string {
  if (error.hint === 'listing_published') return 'Published listings can’t be deleted. Move it to draft or suspend it first.';
  if (error.hint === 'listing_in_use') return `It has ${HISTORY[error.details ?? ''] ?? 'history'}, so it can’t be deleted. Suspend it instead.`;
  if (error.code === '40001') return 'This listing changed. Reload and try again.';
  if (error.code === 'P0002') return 'This listing no longer exists.';
  if (error.code === '42501') return 'Administrator access required.';
  if (error.code === '22023' && action === 'publish') return 'Add an active court before publishing.';
  if (error.code === '22023' || error.code === '22P02' || error.code === '23514') return 'Check the listing details.';
  // PostgREST: no such function, i.e. a database without the 2026-10-13 bulk migration.
  if (error.code === 'PGRST202') return 'Deleting needs the latest database update. Ask the operator to apply it.';
  return 'Unavailable right now. Try again.';
}
