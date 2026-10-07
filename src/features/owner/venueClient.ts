import type {
  Court, CourtStatus, CourtSurface, OwnedVenueSummary, OwnerPhotoAdd, OwnerPhotoRemove, OwnerVenue, OwnerVenuePhoto,
  OwnerVenueSave, PhotoType, VenueClaimStatus, VenuePublicationStatus,
  VenuePolicyView, VenuePolicySave,
} from '@picklyph/domain';

// Pure client for the owner-venues Edge function: type-only domain imports,
// so Node tests can drive it against the real handler.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLICATION: readonly VenuePublicationStatus[] = ['draft', 'approved', 'suspended'];
const CLAIMS: readonly VenueClaimStatus[] = ['unclaimed', 'pending', 'verified'];
const SURFACES: readonly (CourtSurface | null)[] = ['hard', 'synthetic', 'other', null];
const COURT_STATUSES: readonly CourtStatus[] = ['active', 'inactive'];
const PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png)$/;

/** The photo chosen on the device; the server reads the real type and dimensions from its bytes. */
export type PhotoFile = { uri: string; name: string; type: PhotoType; size: number | null };
export type VenueTransport = {
  endpoint: string;
  apiKey: string;
  accessToken: () => Promise<string | null>;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Tests append a Blob; on iOS an expo-file-system File (see liveOwner). */
  photoPart: (file: PhotoFile) => Blob;
};

export type VenueRejection =
  | 'invalid_request' | 'invalid_photo' | 'photo_dimensions' | 'photo_too_large' | 'unsupported_photo'
  | 'too_many_courts' | 'active_court_required' | 'account_required' | 'not_owner' | 'venue_unavailable'
  | 'version_conflict' | 'duplicate_court' | 'too_many_photos' | 'request_reused' | 'merchant_inactive' | 'court_allocated';
/** Transport for the owner JSON endpoints (owner-venues, owner-schedules). */
export type OwnerHttpTransport = Pick<VenueTransport, 'endpoint' | 'apiKey' | 'accessToken' | 'fetch'>;
export type HttpFailure<R extends string> =
  | { kind: 'sign_in' | 'network' | 'unavailable' | 'not_configured'; retryAfterSeconds: number | null }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'rejected'; reason: R; retryAfterSeconds: null };
export type HttpOutcome<T, R extends string> = { ok: true; value: T } | { ok: false; failure: HttpFailure<R> };
export type VenueFailure = HttpFailure<VenueRejection>;
export type VenueOutcome<T> = HttpOutcome<T, VenueRejection>;

const REJECTIONS: readonly VenueRejection[] = ['invalid_request', 'invalid_photo', 'photo_dimensions', 'photo_too_large',
  'unsupported_photo', 'too_many_courts', 'active_court_required', 'account_required', 'not_owner', 'venue_unavailable',
  'version_conflict', 'duplicate_court', 'too_many_photos', 'request_reused', 'merchant_inactive', 'court_allocated'];
const unexpected = (): never => { throw new Error('Unexpected owner venue response.'); };
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const id = (value: unknown): string => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : unexpected());
const instant = (value: unknown): string => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : unexpected());
const count = (value: unknown, max: number): number => (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max ? value as number : unexpected());
const coordinate = (value: unknown, limit: number): number =>
  (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : unexpected());

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : unexpected();
}

function parseCourt(raw: unknown, venueId: string): Court {
  const court = record(raw);
  if (!text(court.name, 80) || !SURFACES.includes(court.surface as CourtSurface | null) || typeof court.is_indoor !== 'boolean'
    || typeof court.is_covered !== 'boolean' || !COURT_STATUSES.includes(court.status as CourtStatus) || id(court.venue_id) !== venueId) return unexpected();
  return { id: id(court.id), venue_id: venueId, name: court.name, surface: court.surface as CourtSurface | null, is_indoor: court.is_indoor,
    is_covered: court.is_covered, status: court.status as CourtStatus, created_at: instant(court.created_at), updated_at: instant(court.updated_at) };
}

function parsePhoto(raw: unknown, venueId: string): OwnerVenuePhoto {
  const photo = record(raw);
  const path = photo.storage_path;
  if (typeof path !== 'string' || !PATH.test(path) || path.slice(0, 36) !== venueId) return unexpected();
  return { id: id(photo.id), storage_path: path, width: count(photo.width, 8192), height: count(photo.height, 8192), created_at: instant(photo.created_at) };
}

export function parseOwnerVenue(raw: unknown): OwnerVenue {
  const venue = record(raw);
  const venueId = id(venue.id);
  if (!text(venue.name, 120) || !text(venue.address_line, 240) || !text(venue.city, 80) || !text(venue.province, 80)
    || !PUBLICATION.includes(venue.publication_status as VenuePublicationStatus) || !CLAIMS.includes(venue.claim_status as VenueClaimStatus)
    || !Array.isArray(venue.courts) || venue.courts.length > 40 || !Array.isArray(venue.photos) || venue.photos.length > 6) return unexpected();
  return {
    id: venueId, name: venue.name, address_line: venue.address_line, city: venue.city, province: venue.province,
    latitude: coordinate(venue.latitude, 90), longitude: coordinate(venue.longitude, 180),
    publication_status: venue.publication_status as VenuePublicationStatus, claim_status: venue.claim_status as VenueClaimStatus,
    // The exact server string (microseconds) is the version token; never reformat it.
    updated_at: instant(venue.updated_at),
    courts: venue.courts.map((court) => parseCourt(court, venueId)),
    photos: venue.photos.map((photo) => parsePhoto(photo, venueId)),
  };
}

export function parseOwnedVenues(raw: unknown): OwnedVenueSummary[] {
  if (!Array.isArray(raw) || raw.length > 50) return unexpected();
  return raw.map((value) => {
    const item = record(value);
    if (!text(item.name, 120) || !text(item.city, 80) || !text(item.province, 80) || typeof item.editable !== 'boolean'
      || !PUBLICATION.includes(item.publication_status as VenuePublicationStatus) || !CLAIMS.includes(item.claim_status as VenueClaimStatus)) return unexpected();
    return { id: id(item.id), name: item.name, city: item.city, province: item.province,
      publication_status: item.publication_status as VenuePublicationStatus, claim_status: item.claim_status as VenueClaimStatus,
      editable: item.editable, active_court_count: count(item.active_court_count, 40), photo_count: count(item.photo_count, 6) };
  });
}

function retryAfter(response: Response, fallback: number | null): number | null {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return fallback;
  return Math.min(Math.max(Number(raw), 1), 3600);
}

async function failure<R extends string>(response: Response, rejections: readonly R[]): Promise<HttpFailure<R>> {
  if (response.status === 401) return { kind: 'sign_in', retryAfterSeconds: null };
  if (response.status === 429) return { kind: 'rate_limited', retryAfterSeconds: retryAfter(response, 1) ?? 1 };
  let error: unknown;
  try { error = record(await response.json()).error; } catch { error = null; }
  if (response.status < 500 && rejections.includes(error as R)) return { kind: 'rejected', reason: error as R, retryAfterSeconds: null };
  return { kind: 'unavailable', retryAfterSeconds: retryAfter(response, null) };
}

// Tagged, never `instanceof Response`: on iOS, expo/fetch returns a FetchResponse that
// implements Response without extending React Native's global Response class.
type Sent = { response: Response } | { failure: HttpFailure<never> };

async function send(transport: OwnerHttpTransport, url: string, init: RequestInit): Promise<Sent> {
  let token: string | null;
  try { token = await transport.accessToken(); } catch { token = null; }
  // Owner commands are never anonymous; the server verifies this token itself.
  if (!token) return { failure: { kind: 'sign_in', retryAfterSeconds: null } };
  try {
    return { response: await transport.fetch(url, { ...init, headers: { ...init.headers, apikey: transport.apiKey, Accept: 'application/json', Authorization: `Bearer ${token}` } }) };
  } catch (error) {
    if (init.signal?.aborted) throw error;
    return { failure: { kind: 'network', retryAfterSeconds: null } };
  }
}

/** One owner JSON request; `rejections` are the endpoint's actionable refusals (anything else is unavailable). */
export async function ownerRequest<T, R extends string>(transport: OwnerHttpTransport, url: string, init: RequestInit,
  parse: (body: Record<string, unknown>) => T, rejections: readonly R[]): Promise<HttpOutcome<T, R>> {
  const sent = await send(transport, url, init);
  if ('failure' in sent) return { ok: false, failure: sent.failure };
  const { response } = sent;
  if (!response.ok) return { ok: false, failure: await failure(response, rejections) };
  try { return { ok: true, value: parse(record(await response.json())) }; }
  catch (error) {
    if (init.signal?.aborted) throw error;
    return { ok: false, failure: { kind: 'unavailable', retryAfterSeconds: null } };
  }
}

function call<T>(transport: VenueTransport, url: string, init: RequestInit, parse: (body: Record<string, unknown>) => T): Promise<VenueOutcome<T>> {
  return ownerRequest(transport, url, init, parse, REJECTIONS);
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function listOwnedVenues(transport: VenueTransport, signal?: AbortSignal) {
  return call(transport, transport.endpoint, { method: 'GET', signal }, (body) => parseOwnedVenues(body.venues));
}

export function loadOwnedVenue(transport: VenueTransport, venueId: string, signal?: AbortSignal) {
  return call(transport, `${transport.endpoint}?${new URLSearchParams({ venue_id: venueId }).toString()}`, { method: 'GET', signal },
    (body) => parseOwnerVenue(body.venue));
}

export function parseVenuePolicy(raw: unknown): VenuePolicyView {
  const p = record(raw);
  if ((p.confirmation !== 'instant' && p.confirmation !== 'approval')
    || (p.payment !== 'arrival' && p.payment !== 'online' && p.payment !== 'both')
    || typeof p.merchant_active !== 'boolean' || (!p.merchant_active && p.payment !== 'arrival')
    || typeof p.revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(p.revision)) return unexpected();
  return { venue_id: id(p.venue_id), revision: p.revision, confirmation: p.confirmation, payment: p.payment, merchant_active: p.merchant_active };
}

export function loadVenuePolicy(transport: VenueTransport, venueId: string, signal?: AbortSignal) {
  return call(transport, `${transport.endpoint}?${new URLSearchParams({ venue_id: venueId, section: 'policies' })}`, { method: 'GET', signal },
    (body) => { const p = parseVenuePolicy(body.policy); return p.venue_id === venueId.toLowerCase() ? p : unexpected(); });
}

export function saveVenuePolicy(transport: VenueTransport, command: VenuePolicySave, signal?: AbortSignal) {
  return call(transport, transport.endpoint, { ...json(command), signal },
    (body) => { const p = parseVenuePolicy(body.policy); return p.venue_id === command.venue_id.toLowerCase() ? p : unexpected(); });
}

/** A version conflict returns `rejected: version_conflict`; reload, then reapply the owner's changes. */
export function saveOwnedVenue(transport: VenueTransport, command: OwnerVenueSave) {
  return call(transport, transport.endpoint, json(command), (body) => parseOwnerVenue(body.venue));
}

/** Retry with the same request_id after a network failure; the server returns the original photo. */
export function addVenuePhoto(transport: VenueTransport, request: OwnerPhotoAdd, file: PhotoFile) {
  const form = new FormData();
  form.append('photo', JSON.stringify(request));
  form.append('file', transport.photoPart(file));
  return call(transport, transport.endpoint, { method: 'POST', body: form }, (body) => parseOwnerVenue(body.venue));
}

export function removeVenuePhoto(transport: VenueTransport, command: Omit<OwnerPhotoRemove, 'kind'>) {
  return call(transport, transport.endpoint, json({ kind: 'remove_photo', ...command }), (body) => parseOwnerVenue(body.venue));
}

export function venueFailureMessage(failure: VenueFailure): string {
  switch (failure.kind) {
    case 'sign_in': return 'Your sign-in has expired. Sign in again from Account, then retry.';
    case 'network': return 'Couldn’t reach pickly. Check your connection, then try again. Your changes are still here.';
    case 'rate_limited': return `Too many changes right now. Try again in ${failure.retryAfterSeconds} seconds.`;
    case 'not_configured': return 'Venue editing isn’t set up in this build.';
    case 'unavailable': return 'Couldn’t confirm your changes. Retry shortly, or reload to check the latest listing.';
    case 'rejected':
      switch (failure.reason) {
        case 'merchant_inactive': return 'Online payment needs verified merchant activation. Choose pay on arrival for now.';
        case 'version_conflict': return 'This listing changed since you opened it. Reload to see the latest, then make your changes again.';
        case 'not_owner': return 'You no longer manage this venue. Contact pickly support if this is a mistake.';
        case 'venue_unavailable': return 'This venue can’t be edited right now. It isn’t published or under review. Contact pickly support.';
        case 'duplicate_court': return 'Another court at this venue already has that name. Give each court its own name.';
        case 'court_allocated': return 'A court with upcoming blocks or bookings can’t be made inactive. Release its blocks in the calendar first.';
        case 'active_court_required': return 'Keep at least one court active. To close the venue, contact pickly support.';
        case 'too_many_courts': return 'A venue can list at most 40 courts.';
        case 'too_many_photos': return 'A venue can show up to 6 photos. Remove one before adding another.';
        case 'photo_too_large': return 'That photo is larger than 5 MB. Choose a smaller photo.';
        case 'unsupported_photo': return 'Choose a JPEG or PNG photo.';
        case 'photo_dimensions': return 'Choose a photo at least 320 pixels on each side and no larger than 25 megapixels.';
        case 'invalid_photo': return 'That photo couldn’t be read. Choose a different photo.';
        case 'account_required': return 'Your account couldn’t be confirmed. Sign out and sign in again.';
        case 'request_reused':
        case 'invalid_request': return 'Something in these changes couldn’t be accepted. Check the details and try again.';
      }
  }
  // Never render a blank failure, even for an unexpected value at runtime.
  return 'Something went wrong. Nothing was changed; try again shortly.';
}
