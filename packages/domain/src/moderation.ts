import type { VenueClaimStatus, VenuePublicationStatus } from './directory.ts';
import type { ReviewCursor } from './review.ts';

// Listing reports and moderation (T46). The database re-checks every rule.
export const REPORT_REASONS = ['wrong_details', 'closed', 'not_a_venue', 'duplicate', 'inappropriate', 'unsafe', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  wrong_details: 'Wrong details (hours, courts, address or pin)',
  closed: 'Permanently closed',
  not_a_venue: 'Not a pickleball venue',
  duplicate: 'Duplicate of another listing',
  inappropriate: 'Inappropriate photos or text',
  unsafe: 'Unsafe place or conduct',
  other: 'Something else',
};
/** Why an owner link was removed. Suspensions reuse the report reasons. */
export const REVOCATION_REASONS = ['not_owner', 'ownership_ended', 'owner_request', 'abuse', 'other'] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];
export const REVOCATION_REASON_LABELS: Record<RevocationReason, string> = {
  not_owner: 'Does not run this venue',
  ownership_ended: 'No longer runs this venue',
  owner_request: 'Owner asked to be removed',
  abuse: 'Misused owner tools',
  other: 'Other reason',
};
export const MAX_REPORT_DETAILS = 500;
/** Report bodies are tiny; 500 code points of details stay well inside. */
export const MAX_REPORT_BYTES = 4096;

export type ReportStatus = 'open' | 'dismissed' | 'resolved';
export type VenueReportRequest = { request_id: string; venue_id: string; reason: ReportReason; details: string | null };
export type VenueReport = {
  id: string;
  venue_id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  created_at: string;
};
export type VenueReportResult = { outcome: 'created' | 'existing'; report: VenueReport };

export type ModerationQueueItem = {
  venue_id: string;
  name: string;
  city: string;
  province: string;
  publication_status: VenuePublicationStatus;
  claim_status: VenueClaimStatus;
  open_reports: number;
  reasons: ReportReason[];
  oldest_report_at: string;
};
export type ModerationQueuePage = { items: ModerationQueueItem[]; next_cursor: ReviewCursor | null; open_total: number };

export type ModerationAuditAction = 'report.submit' | 'report.dismiss' | 'report.resolve' | 'venue.suspend' | 'venue.reinstate' | 'owner.revoke';
export type ModerationEvent = {
  /** Decimal bigint string: never round through a JavaScript number. */
  id: string;
  action: ModerationAuditAction;
  actor_user_id: string;
  /** The report, or the account whose owner link was revoked. */
  subject_id: string | null;
  reason: ReportReason | RevocationReason | null;
  occurred_at: string;
};
export type ModerationReport = VenueReport & {
  reviewed_at: string | null;
  /** Null once the reporter's account is deleted. */
  reporter: { id: string; display_name: string | null } | null;
};
export type ModerationVenue = {
  venue: {
    id: string; name: string; address_line: string; city: string; province: string; latitude: number; longitude: number;
    publication_status: VenuePublicationStatus; claim_status: VenueClaimStatus; active_court_count: number;
  };
  /** Present only while moderation keeps the listing suspended. */
  suspension: { reason: ReportReason; suspended_by: string | null; suspended_at: string } | null;
  owners: { user_id: string; display_name: string | null; verified_at: string }[];
  open_reports: number;
  /** Open first, then newest; at most 100. */
  reports: ModerationReport[];
  /** Newest first; at most 50. */
  history: ModerationEvent[];
};

/**
 * dismiss|resolve close the reports the reviewer saw; suspend takes a published listing
 * down (resolving those reports); reinstate undoes a moderation suspension only.
 */
export type ModerationDecision =
  | { venue_id: string; decision: 'dismiss' | 'resolve'; reason: null; report_ids: string[] }
  | { venue_id: string; decision: 'suspend'; reason: ReportReason; report_ids: string[] }
  | { venue_id: string; decision: 'reinstate'; reason: null; report_ids: [] };
export type OwnershipRevocation = { venue_id: string; owner_user_id: string; reason: RevocationReason };
export type ModerationResult = { outcome: 'decided' | 'existing'; item: ModerationVenue };

export class ModerationInputError extends Error {
  constructor(message = 'Invalid moderation input.') { super(message); this.name = 'ModerationInputError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ModerationInputError();
  return value.toLowerCase();
};
const exactKeys = (raw: unknown, keys: string): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ModerationInputError();
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== keys) throw new ModerationInputError();
  return input;
};
const isReportReason = (value: unknown): value is ReportReason => REPORT_REASONS.some((reason) => reason === value);

/** Typed text → stored details: line breaks normalized, trimmed, empty → null. No other control characters. */
export function readReportDetails(raw: string): string | null {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  // At least as strict as the database's [[:cntrl:]] check, whatever its locale.
  if ([...text].length > MAX_REPORT_DETAILS || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) {
    throw new ModerationInputError('Details must be 500 characters or fewer.');
  }
  return text;
}

/** Strict report body: unknown fields (including any actor) are rejected; details must already be canonical. */
export function readVenueReport(raw: unknown): VenueReportRequest {
  const input = exactKeys(raw, 'details,reason,request_id,venue_id');
  if (!isReportReason(input.reason)) throw new ModerationInputError();
  const details = input.details;
  if (details !== null && (typeof details !== 'string' || readReportDetails(details) !== details)) throw new ModerationInputError();
  return { request_id: uuid(input.request_id), venue_id: uuid(input.venue_id), reason: input.reason, details };
}

/** Strict console decision body: the same rules the database enforces. */
export function readModerationDecision(raw: unknown): ModerationDecision {
  const input = exactKeys(raw, 'decision,reason,report_ids,venue_id');
  const venue_id = uuid(input.venue_id);
  if (!Array.isArray(input.report_ids) || input.report_ids.length > 100) throw new ModerationInputError();
  const report_ids = input.report_ids.map(uuid);
  if (new Set(report_ids).size !== report_ids.length) throw new ModerationInputError();
  const { decision, reason } = input;
  if ((decision === 'dismiss' || decision === 'resolve') && reason === null && report_ids.length > 0) return { venue_id, decision, reason: null, report_ids };
  if (decision === 'suspend' && isReportReason(reason)) return { venue_id, decision, reason, report_ids };
  if (decision === 'reinstate' && reason === null && report_ids.length === 0) return { venue_id, decision, reason: null, report_ids: [] };
  throw new ModerationInputError();
}

export function readOwnershipRevocation(raw: unknown): OwnershipRevocation {
  const input = exactKeys(raw, 'owner_user_id,reason,venue_id');
  if (!REVOCATION_REASONS.some((reason) => reason === input.reason)) throw new ModerationInputError();
  return { venue_id: uuid(input.venue_id), owner_user_id: uuid(input.owner_user_id), reason: input.reason as RevocationReason };
}
