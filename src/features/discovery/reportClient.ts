import { readReportDetails, readVenueReport, toUtcIso, type ReportReason, type VenueReportRequest, type VenueReportResult } from '@picklyph/domain';

import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from '../owner/venueClient';

// Pure client for the venue-reports Edge function (T46), so Node tests drive it against the real handler.
export const REPORT_REJECTIONS = ['invalid_request', 'invalid_input', 'account_required', 'venue_unavailable', 'already_reported',
  'request_reused', 'too_many_reports'] as const;
export type ReportFailure = HttpFailure<typeof REPORT_REJECTIONS[number]>;
export type ReportOutcome = HttpOutcome<VenueReportResult, typeof REPORT_REJECTIONS[number]>;

const unexpected = (): never => { throw new Error('Unexpected report response.'); };
const record = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : unexpected();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgreSQL emits microseconds; normalize only after checking calendar and explicit offset.
const instant = (raw: unknown): string => typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
  ? toUtcIso(raw.replace(/(\.\d{3})\d+/, '$1')) : unexpected();

/** The typed form as the canonical body. Throws ModerationInputError for over-long or control-character details. */
export function reportDraft(input: { requestId: string; venueId: string; reason: ReportReason; details: string }): VenueReportRequest {
  return readVenueReport({ request_id: input.requestId, venue_id: input.venueId, reason: input.reason, details: readReportDetails(input.details) });
}

/** A success must describe exactly the report that was sent; anything else is treated as an uncertain reply. */
function parseResult(raw: Record<string, unknown>, sent: VenueReportRequest): VenueReportResult {
  const report = record(raw.report);
  if ((raw.outcome !== 'created' && raw.outcome !== 'existing') || typeof report.id !== 'string' || !UUID.test(report.id)
    || report.venue_id !== sent.venue_id || report.reason !== sent.reason || report.details !== sent.details
    || !['open', 'dismissed', 'resolved'].includes(report.status as string)) return unexpected();
  return { outcome: raw.outcome as VenueReportResult['outcome'], report: { id: report.id.toLowerCase(), venue_id: sent.venue_id, reason: sent.reason, details: sent.details,
    status: report.status as VenueReportResult['report']['status'], created_at: instant(report.created_at) } };
}

export function submitReport(transport: OwnerHttpTransport, report: VenueReportRequest): Promise<ReportOutcome> {
  const original = readVenueReport(report);
  return ownerRequest(transport, transport.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(original) },
    (body) => parseResult(body, original), REPORT_REJECTIONS);
}

export function reportFailureMessage(f: ReportFailure): string {
  if (f.kind === 'rejected') {
    const messages: Record<typeof REPORT_REJECTIONS[number], string> = {
      already_reported: 'You’ve already reported this listing. A pickly reviewer will look at it.',
      too_many_reports: 'You have many reports waiting for review. Try again after reviewers catch up.',
      venue_unavailable: 'This listing is no longer on Discover, so it can’t be reported.',
      account_required: 'Sign in again, then send the report.',
      request_reused: 'Something went wrong with this report. Close this screen and start again.',
      invalid_input: 'Check the details: 500 characters at most, with no special characters.',
      invalid_request: 'Check the details and try again.',
    };
    return messages[f.reason];
  }
  if (f.kind === 'rate_limited') return `Too many reports at once. Try again in ${f.retryAfterSeconds} seconds.`;
  if (f.kind === 'sign_in') return 'Sign in again, then send the report.';
  if (f.kind === 'not_configured') return 'Reports aren’t configured in this build.';
  return 'Couldn’t confirm the report was sent. Try again: sending the same report twice won’t create a duplicate.';
}
