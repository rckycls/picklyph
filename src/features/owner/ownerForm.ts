import {
  MAX_EVIDENCE_BYTES, OwnerInputError, inSubmissionBounds, readOwnerNote, readOwnerVenueInput,
  type AddressCandidate, type EvidenceType, type OwnerClaimRequest, type OwnerSubmission, type OwnerVenueRequest,
} from '@picklyph/domain';

export type Pin = { latitude: number; longitude: number };
export type VenueDraft = { name: string; address_line: string; city: string; province: string; courts: string; note: string };
export const EMPTY_DRAFT: VenueDraft = { name: '', address_line: '', city: '', province: '', courts: '', note: '' };
type Built<T> = { ok: true; request: T } | { ok: false; message: string };

/** A chosen suggestion moves the pin and fills only empty fields; the owner's own text wins. */
export function applyCandidate(draft: VenueDraft, candidate: AddressCandidate): VenueDraft {
  return {
    ...draft,
    address_line: draft.address_line.trim() || candidate.address_line,
    city: draft.city.trim() || candidate.city,
    province: draft.province.trim() || candidate.province,
  };
}

export function pinProblem(pin: Pin | null): string | null {
  if (!pin) return 'Place the pin on the venue.';
  return inSubmissionBounds(pin.latitude, pin.longitude) ? null : 'Place the pin on a venue in the Philippines.';
}

function message(error: unknown): string {
  return error instanceof OwnerInputError ? error.message : 'Check the details and try again.';
}

export function venueRequest(draft: VenueDraft, pin: Pin | null, requestId: string, acknowledgeDuplicates: boolean): Built<OwnerVenueRequest> {
  const problem = pinProblem(pin);
  if (problem || !pin) return { ok: false, message: problem ?? 'Place the pin on the venue.' };
  const courts = draft.courts.trim();
  if (!/^\d{1,2}$/.test(courts)) return { ok: false, message: 'Enter between 1 and 40 courts.' };
  try {
    const venue = readOwnerVenueInput({
      name: draft.name, address_line: draft.address_line, city: draft.city, province: draft.province,
      latitude: Number(pin.latitude.toFixed(6)), longitude: Number(pin.longitude.toFixed(6)), court_count: Number(courts),
    });
    return { ok: true, request: { kind: 'venue', request_id: requestId, venue, note: readOwnerNote(draft.note), acknowledge_duplicates: acknowledgeDuplicates } };
  } catch (error) { return { ok: false, message: message(error) }; }
}

export function claimRequest(venueId: string, note: string, requestId: string): Built<OwnerClaimRequest> {
  try { return { ok: true, request: { kind: 'claim', request_id: requestId, venue_id: venueId, note: readOwnerNote(note) } }; }
  catch (error) { return { ok: false, message: message(error) }; }
}

/** Device-side precheck; the server re-checks size and reads the real type from the bytes. */
export function evidenceProblem(file: { uri: string; mimeType?: string | null; fileSize?: number | null }): { type: EvidenceType } | { problem: string } {
  const extension = /\.(jpe?g|png)$/i.exec(file.uri)?.[1]?.toLowerCase();
  const type = file.mimeType?.toLowerCase() ?? (extension === 'png' ? 'image/png' : extension ? 'image/jpeg' : undefined);
  if (type !== 'image/jpeg' && type !== 'image/png') return { problem: 'Choose a JPEG or PNG photo.' };
  if (typeof file.fileSize === 'number' && file.fileSize > MAX_EVIDENCE_BYTES) return { problem: 'That photo is larger than 5 MB. Choose a smaller photo.' };
  return { type };
}

export function distanceLabel(meters: number): string {
  return meters < 1000 ? `${Math.max(1, Math.round(meters))} m away` : `${(meters / 1000).toFixed(1)} km away`;
}

export function submissionBadge(submission: Pick<OwnerSubmission, 'kind' | 'status'>): { label: string; tone: 'pending' | 'success' | 'error' } {
  switch (submission.status) {
    case 'pending': return { label: submission.kind === 'claim' ? 'Claim under review' : 'Venue under review', tone: 'pending' };
    case 'approved': return { label: 'Approved', tone: 'success' };
    case 'rejected': return { label: 'Not approved', tone: 'error' };
  }
}
