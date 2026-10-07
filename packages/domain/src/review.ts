import type { VenueClaimStatus, VenuePublicationStatus } from './directory.ts';
import type { OwnerSubmissionStatus } from './owner.ts';

// Ownership review (T17). Console reviewers only; the database re-checks every rule.
export const REVIEW_REJECTION_REASONS = ['insufficient_evidence', 'not_owner', 'duplicate', 'not_a_venue', 'other'] as const;
export type ReviewRejectionReason = (typeof REVIEW_REJECTION_REASONS)[number];
export const REVIEW_REASON_LABELS: Record<ReviewRejectionReason, string> = {
  insufficient_evidence: 'Proof does not show ownership',
  not_owner: 'Someone else runs this venue',
  duplicate: 'Duplicate of another listing or request',
  not_a_venue: 'Not a pickleball venue',
  other: 'Other reason',
};

/**
 * Claims: approve|reject. New venues: approve (admin only: publishes the owner's draft),
 * merge into an existing listing, or reject; merge and reject retire the draft.
 */
export type OwnershipDecision =
  | { subject_id: string; decision: 'approve'; target_venue_id: null; rejection_reason: null }
  | { subject_id: string; decision: 'merge'; target_venue_id: string; rejection_reason: null }
  | { subject_id: string; decision: 'reject'; target_venue_id: null; rejection_reason: ReviewRejectionReason };

export type ReviewCursor = { created_at: string; id: string };
export type OwnershipQueueItem = {
  id: string;
  kind: 'claim' | 'venue';
  created_at: string;
  name: string;
  city: string;
  province: string;
  venue_id: string | null;
  /** Claims: other pending claims + current owners. Venues: nearby listings/submissions at submission time. */
  duplicate_signals: number;
};
export type OwnershipQueuePage = { items: OwnershipQueueItem[]; next_cursor: ReviewCursor | null; pending_total: number };

export type ReviewSubmitter = {
  id: string;
  display_name: string | null;
  joined_at: string;
  pending: number;
  approved: number;
  rejected: number;
};
export type ReviewOutcome = {
  reviewed_by: string | null;
  reviewed_at: string;
  reason: ReviewRejectionReason | null;
  resolution: 'new' | 'merge' | null;
  resolved_venue_id: string | null;
};
type ReviewBase = {
  id: string;
  status: OwnerSubmissionStatus;
  created_at: string;
  note: string | null;
  submitter: ReviewSubmitter;
  review: ReviewOutcome | null;
};
export type ClaimReview = ReviewBase & {
  kind: 'claim';
  venue: {
    id: string; name: string; address_line: string; city: string; province: string;
    latitude: number; longitude: number;
    publication_status: VenuePublicationStatus; claim_status: VenueClaimStatus; owner_count: number;
  };
  other_pending_claims: number;
};
export type VenueSubmissionReview = ReviewBase & {
  kind: 'venue';
  /** As first submitted. */
  proposed: { name: string; address_line: string; city: string; province: string; latitude: number; longitude: number; court_count: number };
  /** The owner's listing as they have set it up since. Null for submissions decided before owners created drafts. */
  draft: {
    id: string; name: string; address_line: string; city: string; province: string; latitude: number; longitude: number;
    publication_status: VenuePublicationStatus; claim_status: VenueClaimStatus; active_court_count: number; photo_count: number;
  } | null;
  duplicates_acknowledged: boolean;
  nearby_venues: {
    id: string; name: string; address_line: string; city: string; province: string;
    publication_status: VenuePublicationStatus; claim_status: VenueClaimStatus; distance_m: number; in_snapshot: boolean;
  }[];
  nearby_submissions: { id: string; name: string; status: OwnerSubmissionStatus; distance_m: number; same_submitter: boolean; in_snapshot: boolean }[];
};
export type OwnershipReview = ClaimReview | VenueSubmissionReview;
export type OwnershipDecisionResult = { outcome: 'decided' | 'existing'; item: OwnershipReview };

export class ReviewInputError extends Error {
  constructor(message = 'Invalid review decision.') { super(message); this.name = 'ReviewInputError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ReviewInputError();
  return value.toLowerCase();
};

/** Strict decision body: unknown fields (including any actor) are rejected. */
export function readOwnershipDecision(raw: unknown): OwnershipDecision {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ReviewInputError();
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'decision,rejection_reason,subject_id,target_venue_id') throw new ReviewInputError();
  const subject_id = uuid(input.subject_id);
  const { decision, target_venue_id: target, rejection_reason: reason } = input;
  if (decision === 'approve' && target === null && reason === null) {
    return { subject_id, decision, target_venue_id: null, rejection_reason: null };
  }
  if (decision === 'merge' && reason === null) return { subject_id, decision, target_venue_id: uuid(target), rejection_reason: null };
  if (decision === 'reject' && target === null && REVIEW_REJECTION_REASONS.some((value) => value === reason)) {
    return { subject_id, decision, target_venue_id: null, rejection_reason: reason as ReviewRejectionReason };
  }
  throw new ReviewInputError();
}

/** `?after=<created_at>~<id>` keyset cursor for the pending queue. */
export function readReviewCursor(value: string | null | undefined): ReviewCursor | null {
  if (value === null || value === undefined || value === '') return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))~([0-9a-f-]{36})$/i.exec(value);
  if (!match?.[1] || !match[2] || Number.isNaN(Date.parse(match[1]))) throw new ReviewInputError('Invalid queue cursor.');
  return { created_at: match[1], id: uuid(match[2]) };
}

export function formatReviewCursor(cursor: ReviewCursor): string {
  return `${cursor.created_at}~${cursor.id}`;
}
