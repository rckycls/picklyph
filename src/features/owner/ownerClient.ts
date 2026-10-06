import type {
  AddressCandidate, EvidenceType, OwnerDuplicate, OwnerSubmission, OwnerSubmissionRequest, VenueClaimStatus,
} from '@picklyph/domain';

// Pure client for the owner-submissions Edge function: type-only domain imports,
// so Node tests can drive it against the real handler.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAIMS: readonly VenueClaimStatus[] = ['unclaimed', 'pending', 'verified'];
const STATUSES: readonly OwnerSubmission['status'][] = ['pending', 'approved', 'rejected'];

/** The photo chosen on the device; only the server decides its stored name and type. */
export type EvidenceFile = { uri: string; name: string; type: EvidenceType; size: number | null };
export type OwnerTransport = {
  endpoint: string;
  apiKey: string;
  accessToken: () => Promise<string | null>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Tests append a Blob; React Native streams a `{ uri, name, type }` file part (see liveOwner). */
  evidencePart: (file: EvidenceFile) => Blob;
};

export type OwnerRejection =
  | 'invalid_submission' | 'invalid_evidence' | 'evidence_too_large' | 'unsupported_evidence' | 'account_required'
  | 'listing_unavailable' | 'already_verified' | 'already_pending' | 'request_reused' | 'too_many_pending';
export type OwnerFailure =
  | { kind: 'sign_in' | 'network' | 'unavailable' | 'not_configured' | 'address_search_unavailable'; retryAfterSeconds: number | null }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'rejected'; reason: OwnerRejection; retryAfterSeconds: null };
export type OwnerOutcome<T> = { ok: true; value: T } | { ok: false; failure: OwnerFailure };
export type SubmitValue =
  | { status: 'created' | 'existing'; submission: OwnerSubmission; duplicates: OwnerDuplicate[] }
  | { status: 'duplicates'; duplicates: OwnerDuplicate[] };

const REJECTIONS: readonly OwnerRejection[] = ['invalid_submission', 'invalid_evidence', 'evidence_too_large', 'unsupported_evidence',
  'account_required', 'listing_unavailable', 'already_verified', 'already_pending', 'request_reused', 'too_many_pending'];
const unexpected = (): never => { throw new Error('Unexpected owner response.'); };
const text = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max;
const coordinate = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : unexpected();
}

export function parseSubmission(raw: unknown): OwnerSubmission {
  const item = record(raw);
  const { id, kind, status, venue_id: venue, created_at: created } = item;
  if (!(typeof id === 'string' && UUID.test(id)) || (kind !== 'claim' && kind !== 'venue')
    || !STATUSES.includes(status as OwnerSubmission['status']) || !text(item.name, 120) || !text(item.city, 80)
    || !(typeof created === 'string' && Number.isFinite(Date.parse(created)))
    || (kind === 'claim' ? !(typeof venue === 'string' && UUID.test(venue)) : venue !== null)) return unexpected();
  return { id: id.toLowerCase(), kind, status: status as OwnerSubmission['status'], venue_id: typeof venue === 'string' ? venue.toLowerCase() : null,
    name: item.name as string, city: item.city as string, created_at: created };
}

export function parseDuplicates(raw: unknown): OwnerDuplicate[] {
  if (!Array.isArray(raw) || raw.length > 10) return unexpected();
  return raw.map((value) => {
    const item = record(value);
    if (!(typeof item.id === 'string' && UUID.test(item.id)) || !text(item.name, 120) || !text(item.address_line, 240)
      || !text(item.city, 80) || !text(item.province, 80) || !CLAIMS.includes(item.claim_status as VenueClaimStatus)
      || !Number.isSafeInteger(item.distance_m) || (item.distance_m as number) < 0) return unexpected();
    return { id: item.id.toLowerCase(), name: item.name as string, address_line: item.address_line as string, city: item.city as string,
      province: item.province as string, claim_status: item.claim_status as VenueClaimStatus, distance_m: item.distance_m as number };
  });
}

export function parseCandidates(raw: unknown): AddressCandidate[] {
  if (!Array.isArray(raw) || raw.length > 5) return unexpected();
  return raw.map((value) => {
    const item = record(value);
    if (!text(item.label, 240) || !text(item.address_line, 240) || !text(item.city, 80, true) || !text(item.province, 80, true)
      || !coordinate(item.latitude, 90) || !coordinate(item.longitude, 180)) return unexpected();
    return { label: item.label as string, address_line: item.address_line as string, city: item.city as string,
      province: item.province as string, latitude: item.latitude as number, longitude: item.longitude as number };
  });
}

function retryAfter(response: Response, fallback: number | null): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return fallback;
  return Math.min(Math.max(Number(raw), 1), 3600);
}

async function failure(response: Response): Promise<OwnerFailure> {
  if (response.status === 401) return { kind: 'sign_in', retryAfterSeconds: null };
  if (response.status === 429) return { kind: 'rate_limited', retryAfterSeconds: retryAfter(response, 1) ?? 1 };
  let error: unknown;
  try { error = record(await response.json()).error; } catch { error = null; }
  if (error === 'address_search_unavailable') return { kind: 'address_search_unavailable', retryAfterSeconds: retryAfter(response, null) };
  if (response.status < 500 && REJECTIONS.includes(error as OwnerRejection)) {
    return { kind: 'rejected', reason: error as OwnerRejection, retryAfterSeconds: null };
  }
  return { kind: 'unavailable', retryAfterSeconds: retryAfter(response, null) };
}

async function send(transport: OwnerTransport, url: string, init: RequestInit): Promise<Response | OwnerFailure> {
  let token: string | null;
  try { token = await transport.accessToken(); } catch { token = null; }
  // Owner commands are never anonymous; the server verifies this token itself.
  if (!token) return { kind: 'sign_in', retryAfterSeconds: null };
  try {
    return await transport.fetch(url, { ...init, headers: { ...init.headers, apikey: transport.apiKey, Accept: 'application/json', Authorization: `Bearer ${token}` } });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    return { kind: 'network', retryAfterSeconds: null };
  }
}

async function lookup<T>(transport: OwnerTransport, params: URLSearchParams, field: string, parse: (raw: unknown) => T, signal?: AbortSignal): Promise<OwnerOutcome<T>> {
  const response = await send(transport, `${transport.endpoint}?${params.toString()}`, { method: 'GET', signal });
  if (!(response instanceof Response)) return { ok: false, failure: response };
  if (!response.ok) return { ok: false, failure: await failure(response) };
  try { return { ok: true, value: parse(record(await response.json())[field]) }; }
  catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, failure: { kind: 'unavailable', retryAfterSeconds: null } };
  }
}

export function searchAddress(transport: OwnerTransport, address: string, signal?: AbortSignal) {
  return lookup(transport, new URLSearchParams({ address }), 'candidates', parseCandidates, signal);
}

/** Approved listings near the pin, before the owner fills in details. */
export function findNearbyListings(transport: OwnerTransport, pin: { latitude: number; longitude: number }, name: string | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ latitude: pin.latitude.toFixed(6), longitude: pin.longitude.toFixed(6) });
  if (name) params.set('name', name);
  return lookup(transport, params, 'duplicates', parseDuplicates, signal);
}

/** One multipart command; retry with the same request (and request_id) after a network failure. */
export async function submitOwner(transport: OwnerTransport, request: OwnerSubmissionRequest, evidence: EvidenceFile): Promise<OwnerOutcome<SubmitValue>> {
  const form = new FormData();
  form.append('submission', JSON.stringify(request));
  form.append('evidence', transport.evidencePart(evidence));
  const response = await send(transport, transport.endpoint, { method: 'POST', body: form });
  if (!(response instanceof Response)) return { ok: false, failure: response };
  try {
    if (response.status === 409) {
      const body = record(await response.clone().json());
      if (body.error === 'possible_duplicates') return { ok: true, value: { status: 'duplicates', duplicates: parseDuplicates(body.duplicates) } };
    }
    if (!response.ok) return { ok: false, failure: await failure(response) };
    const body = record(await response.json());
    return { ok: true, value: { status: response.status === 201 ? 'created' : 'existing',
      submission: parseSubmission(body.submission), duplicates: parseDuplicates(body.duplicates) } };
  } catch {
    return { ok: false, failure: { kind: 'unavailable', retryAfterSeconds: null } };
  }
}

export function parseMySubmissions(raw: unknown): OwnerSubmission[] {
  if (!Array.isArray(raw) || raw.length > 50) return unexpected();
  return raw.map(parseSubmission);
}

export function ownerFailureMessage(failure: OwnerFailure): string {
  switch (failure.kind) {
    case 'sign_in': return 'Your sign-in has expired. Sign in again from Account, then retry.';
    case 'network': return 'Couldn’t reach pickly. Check your connection, then try again. Your details are still here.';
    case 'rate_limited': return `Too many requests right now. Try again in ${failure.retryAfterSeconds} seconds.`;
    case 'not_configured': return 'Owner submissions aren’t set up in this build.';
    case 'address_search_unavailable': return 'Address search isn’t available right now. Move the map or use your location to place the pin.';
    case 'unavailable': return 'Submissions are unavailable right now. Nothing was submitted; try again shortly.';
    case 'rejected':
      switch (failure.reason) {
        case 'evidence_too_large': return 'That photo is larger than 5 MB. Choose a smaller photo.';
        case 'unsupported_evidence': return 'Choose a JPEG or PNG photo.';
        case 'listing_unavailable': return 'This listing is no longer in the directory.';
        case 'already_verified': return 'This listing already has a verified owner. Contact pickly support if you also manage it.';
        case 'already_pending': return 'You already have a submission for this place awaiting review.';
        case 'too_many_pending': return 'You have 5 submissions awaiting review. Wait for a decision before adding more.';
        case 'account_required': return 'Your account couldn’t be confirmed. Sign out and sign in again.';
        case 'request_reused':
        case 'invalid_submission':
        case 'invalid_evidence': return 'Something in this submission couldn’t be accepted. Check the details and try again.';
      }
  }
}
