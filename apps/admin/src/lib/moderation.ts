// Pure moderation helpers shared by the route handlers, pages and unit tests.
import type { ModerationAuditAction } from '@picklyph/domain';
import type { ReviewRejection } from './ownership';

/** Maps the database's machine-readable hint (then SQLSTATE) to a reviewer message. Null = unexpected. */
export function moderationRejection(error: { code?: string | null; hint?: string | null }): ReviewRejection | null {
  switch (error.hint) {
    case 'self_moderation': return { status: 403, message: 'You own, claimed or submitted this listing, so another reviewer must decide.' };
    case 'moderator_required': return { status: 403, message: 'Moderator access required.' };
    case 'already_decided': return { status: 409, message: 'Another reviewer already decided one of these reports. Reload to see the decision.' };
    case 'not_published': return { status: 409, message: 'Only a published listing can be suspended here. Drafts and listings an administrator suspended are managed in the directory.' };
    case 'not_moderation_suspension': return { status: 409, message: 'Only a moderation suspension can be lifted here. Ask an administrator to publish the listing from the directory.' };
    case 'active_court_required': return { status: 409, message: 'The listing has no active court. An administrator must activate one before it can be published again.' };
    case 'not_found': return { status: 404, message: 'This listing no longer exists.' };
    case 'invalid_input': return { status: 400, message: 'Check the decision and try again.' };
  }
  if (error.code === '42501') return { status: 403, message: 'Moderator access required.' };
  if (error.code === '22023' || error.code === '22P02') return { status: 400, message: 'Check the decision and try again.' };
  return null;
}

export const MODERATION_ACTION_LABELS: Record<ModerationAuditAction, string> = {
  'report.submit': 'Report received',
  'report.dismiss': 'Report dismissed',
  'report.resolve': 'Report resolved',
  'venue.suspend': 'Listing suspended',
  'venue.reinstate': 'Suspension lifted',
  'owner.revoke': 'Owner removed',
};
