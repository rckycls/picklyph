import type { CourtInput } from './curation.ts';
import type { Court, Venue, VenueClaimStatus, VenuePublicationStatus } from './directory.ts';

// Owner venue editing (T18). The database re-validates every rule independently;
// these readers give the mobile editor and the Edge function the same contract.
export const MAX_VENUE_PHOTOS = 6;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Shortest and longest allowed side, in pixels, after EXIF rotation. */
export const MIN_PHOTO_SIDE = 320;
export const MAX_PHOTO_SIDE = 8192;
/** Keeps a small file from decoding into a huge bitmap on players' phones. */
export const MAX_PHOTO_PIXELS = 25_000_000;
export const MAX_OWNER_COURTS = 40;
export const VENUE_PHOTO_BUCKET = 'venue-photos';

export type PhotoType = 'image/jpeg' | 'image/png';
export type OwnerVenuePhoto = { id: string; storage_path: string; width: number; height: number; created_at: string };
/** Everything an owner edits. Pin, publication and claim status are shown, never sent back. */
export type OwnerVenue = Pick<Venue, 'id' | 'name' | 'address_line' | 'city' | 'province' | 'latitude' | 'longitude'
  | 'publication_status' | 'claim_status' | 'updated_at'> & { courts: Court[]; photos: OwnerVenuePhoto[] };
export type OwnedVenueSummary = {
  id: string;
  name: string;
  city: string;
  province: string;
  publication_status: VenuePublicationStatus;
  claim_status: VenueClaimStatus;
  /** Approved and verified: the only state owners can edit. */
  editable: boolean;
  active_court_count: number;
  photo_count: number;
};
export type OwnerVenueDetails = Pick<Venue, 'name' | 'address_line' | 'city' | 'province'>;
export type OwnerVenueSave = {
  kind: 'save';
  venue_id: string;
  /** The listing's `updated_at` exactly as read (microseconds included). */
  expected_updated_at: string;
  venue: OwnerVenueDetails;
  courts: CourtInput[];
};
export type OwnerPhotoRemove = { kind: 'remove_photo'; venue_id: string; photo_id: string };
export type OwnerVenueCommand = OwnerVenueSave | OwnerPhotoRemove;
/** JSON `photo` part of the multipart upload. */
export type OwnerPhotoAdd = { venue_id: string; request_id: string };
export type OwnerPhotoAddResult = { outcome: 'created' | 'existing'; venue: OwnerVenue };
export type OwnerPhotoRemoveResult = { removed_path: string | null; venue: OwnerVenue };

/** Self-contained (no runtime imports), so Deno, Node tests and Metro load it alike. */
export class VenueInputError extends Error {
  constructor(message = 'Check the venue details and try again.') { super(message); this.name = 'VenueInputError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const VERSION = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/;

function fields(raw: unknown, expected: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new VenueInputError();
  if (Object.keys(raw).sort().join(',') !== expected) throw new VenueInputError();
  return raw as Record<string, unknown>;
}

/** Trims and collapses whitespace; rejects control characters. */
export function readOwnerText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw new VenueInputError(`Enter the ${field}.`);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1) throw new VenueInputError(`Enter the ${field}.`);
  if ([...trimmed].length > max || CONTROL.test(trimmed)) throw new VenueInputError(`Shorten the ${field} to ${max} characters.`);
  return trimmed;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new VenueInputError();
  return value.toLowerCase();
}

export function readOwnerVenueDetails(raw: unknown): OwnerVenueDetails {
  const input = fields(raw, 'address_line,city,name,province');
  return {
    name: readOwnerText(input.name, 120, 'venue name'),
    address_line: readOwnerText(input.address_line, 240, 'street address'),
    city: readOwnerText(input.city, 80, 'city or municipality'),
    province: readOwnerText(input.province, 80, 'province'),
  };
}

/** Same court rules as directory curation (T11), with owner-friendly messages. */
export function readOwnerCourts(raw: unknown): CourtInput[] {
  if (!Array.isArray(raw)) throw new VenueInputError();
  if (raw.length > MAX_OWNER_COURTS) throw new VenueInputError(`A venue can list at most ${MAX_OWNER_COURTS} courts.`);
  const names = new Set<string>();
  const ids = new Set<string>();
  return raw.map((item) => {
    const court = fields(item, 'id,is_covered,is_indoor,name,status,surface');
    const name = readOwnerText(court.name, 80, 'court name');
    if (names.has(name)) throw new VenueInputError(`Two courts are named “${name}”. Give each court its own name.`);
    names.add(name);
    const id = court.id === null ? null : uuid(court.id);
    if (id && ids.has(id)) throw new VenueInputError();
    if (id) ids.add(id);
    if (court.surface !== null && court.surface !== 'hard' && court.surface !== 'synthetic' && court.surface !== 'other') throw new VenueInputError();
    if (typeof court.is_indoor !== 'boolean' || typeof court.is_covered !== 'boolean') throw new VenueInputError();
    if (court.status !== 'active' && court.status !== 'inactive') throw new VenueInputError();
    return { id, name, surface: court.surface, is_indoor: court.is_indoor, is_covered: court.is_covered, status: court.status };
  });
}

/** Parses the JSON body of `POST /owner-venues`. */
export function readOwnerVenueCommand(json: string): OwnerVenueCommand {
  if (json.length > 32 * 1024) throw new VenueInputError();
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new VenueInputError(); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new VenueInputError();
  const kind = (raw as Record<string, unknown>).kind;
  if (kind === 'save') {
    const body = fields(raw, 'courts,expected_updated_at,kind,venue,venue_id');
    const version = body.expected_updated_at;
    if (typeof version !== 'string' || !VERSION.test(version) || !Number.isFinite(Date.parse(version))) throw new VenueInputError();
    // V8 accepts impossible dates such as Feb 30, which PostgreSQL rejects.
    const [year, month, day] = version.slice(0, 10).split('-').map(Number) as [number, number, number];
    const calendar = new Date(Date.UTC(year, month - 1, day));
    if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw new VenueInputError();
    return { kind: 'save', venue_id: uuid(body.venue_id), expected_updated_at: version,
      venue: readOwnerVenueDetails(body.venue), courts: readOwnerCourts(body.courts) };
  }
  if (kind === 'remove_photo') {
    const body = fields(raw, 'kind,photo_id,venue_id');
    return { kind: 'remove_photo', venue_id: uuid(body.venue_id), photo_id: uuid(body.photo_id) };
  }
  throw new VenueInputError();
}

export function readOwnerPhotoAdd(json: string): OwnerPhotoAdd {
  if (json.length > 1024) throw new VenueInputError();
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new VenueInputError(); }
  const body = fields(raw, 'request_id,venue_id');
  return { venue_id: uuid(body.venue_id), request_id: uuid(body.request_id) };
}

/** `GET` (your venues) or `GET ?venue_id=` (one editable listing). */
export function readOwnerVenueQuery(params: URLSearchParams): { venue_id: string | null } {
  const keys = [...params.keys()];
  if (keys.length === 0) return { venue_id: null };
  if (keys.length !== 1 || keys[0] !== 'venue_id') throw new VenueInputError();
  return { venue_id: uuid(params.get('venue_id')) };
}

/** Pixel limits on display dimensions (after EXIF rotation). */
export function photoDimensionsAllowed(width: number, height: number): boolean {
  return [width, height].every((side) => Number.isSafeInteger(side) && side >= MIN_PHOTO_SIDE && side <= MAX_PHOTO_SIDE)
    && width * height <= MAX_PHOTO_PIXELS;
}
