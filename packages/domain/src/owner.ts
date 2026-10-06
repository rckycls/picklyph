import type { VenueClaimStatus } from './directory.ts';

// Owner submissions (T15). The database re-validates every rule independently;
// these readers give the mobile form and the Edge function the same contract.
export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const MAX_OWNER_NOTE = 500;
export const MAX_PENDING_OWNER_SUBMISSIONS = 5;
export const MAX_SUBMISSION_COURTS = 40;
/** Approved listings this close to a pin are possible duplicates (or a similar name within 2 km). */
export const DUPLICATE_RADIUS_METERS = 150;
/** Generous Philippines box; pins outside it are rejected. */
export const SUBMISSION_BOUNDS = { south: 4, west: 116, north: 21.5, east: 127 } as const;

export type EvidenceType = 'image/jpeg' | 'image/png';
export type OwnerVenueInput = {
  name: string;
  address_line: string;
  city: string;
  province: string;
  latitude: number;
  longitude: number;
  court_count: number;
};
export type OwnerClaimRequest = { kind: 'claim'; request_id: string; venue_id: string; note: string | null };
export type OwnerVenueRequest = {
  kind: 'venue';
  request_id: string;
  venue: OwnerVenueInput;
  note: string | null;
  acknowledge_duplicates: boolean;
};
export type OwnerSubmissionRequest = OwnerClaimRequest | OwnerVenueRequest;

export type OwnerSubmissionStatus = 'pending' | 'approved' | 'rejected';
/** Everything a submitter sees about their own record: no evidence, notes or reviewer data. */
export type OwnerSubmission = {
  id: string;
  kind: 'claim' | 'venue';
  status: OwnerSubmissionStatus;
  venue_id: string | null;
  name: string;
  city: string;
  created_at: string;
};
/** Approved public listing near a proposed pin. */
export type OwnerDuplicate = {
  id: string;
  name: string;
  address_line: string;
  city: string;
  province: string;
  claim_status: VenueClaimStatus;
  distance_m: number;
};
export type OwnerSubmitResult = {
  outcome: 'created' | 'existing' | 'duplicates';
  submission: OwnerSubmission | null;
  duplicates: OwnerDuplicate[];
};
/** Address search suggestion; the owner confirms the pin and text before submitting. */
export type AddressCandidate = {
  label: string;
  address_line: string;
  city: string;
  province: string;
  latitude: number;
  longitude: number;
};

export class OwnerInputError extends Error {
  constructor(message = 'Invalid owner submission.') { super(message); this.name = 'OwnerInputError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const NOTE_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function inSubmissionBounds(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= SUBMISSION_BOUNDS.south && latitude <= SUBMISSION_BOUNDS.north
    && longitude >= SUBMISSION_BOUNDS.west && longitude <= SUBMISSION_BOUNDS.east;
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw new OwnerInputError(`Enter the ${field}.`);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 1) throw new OwnerInputError(`Enter the ${field}.`);
  if ([...trimmed].length > max || CONTROL.test(trimmed)) throw new OwnerInputError(`Shorten the ${field} to ${max} characters.`);
  return trimmed;
}

/** Optional note; blank becomes null. Line breaks are kept. */
export function readOwnerNote(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new OwnerInputError('Invalid note.');
  const trimmed = value.replace(/\r\n?/g, '\n').trim();
  if (trimmed === '') return null;
  if ([...trimmed].length > MAX_OWNER_NOTE || NOTE_CONTROL.test(trimmed)) {
    throw new OwnerInputError(`Keep the note under ${MAX_OWNER_NOTE} characters.`);
  }
  return trimmed;
}

export function readOwnerVenueInput(raw: unknown): OwnerVenueInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new OwnerInputError();
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'address_line,city,court_count,latitude,longitude,name,province') throw new OwnerInputError();
  const { latitude, longitude, court_count: courts } = input;
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !inSubmissionBounds(latitude, longitude)) {
    throw new OwnerInputError('Place the pin on the venue in the Philippines.');
  }
  if (typeof courts !== 'number' || !Number.isInteger(courts) || courts < 1 || courts > MAX_SUBMISSION_COURTS) {
    throw new OwnerInputError(`Enter between 1 and ${MAX_SUBMISSION_COURTS} courts.`);
  }
  return {
    name: text(input.name, 120, 'venue name'),
    address_line: text(input.address_line, 240, 'street address'),
    city: text(input.city, 80, 'city or municipality'),
    province: text(input.province, 80, 'province'),
    latitude, longitude, court_count: courts,
  };
}

/** Parses the JSON `submission` part of the multipart command. */
export function readOwnerSubmission(json: string): OwnerSubmissionRequest {
  if (json.length > 4096) throw new OwnerInputError();
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new OwnerInputError(); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new OwnerInputError();
  const body = raw as Record<string, unknown>;
  if (!isUuid(body.request_id)) throw new OwnerInputError();
  const request_id = body.request_id.toLowerCase();
  if (body.kind === 'claim') {
    if (Object.keys(body).sort().join(',') !== 'kind,note,request_id,venue_id' || !isUuid(body.venue_id)) throw new OwnerInputError();
    return { kind: 'claim', request_id, venue_id: body.venue_id.toLowerCase(), note: readOwnerNote(body.note) };
  }
  if (body.kind === 'venue') {
    if (Object.keys(body).sort().join(',') !== 'acknowledge_duplicates,kind,note,request_id,venue'
      || typeof body.acknowledge_duplicates !== 'boolean') throw new OwnerInputError();
    return { kind: 'venue', request_id, venue: readOwnerVenueInput(body.venue), note: readOwnerNote(body.note),
      acknowledge_duplicates: body.acknowledge_duplicates };
  }
  throw new OwnerInputError();
}

/** Identifies evidence by its leading bytes, never by a client-supplied name or type. */
export function sniffEvidence(bytes: Uint8Array): EvidenceType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) return 'image/png';
  return null;
}

/** `GET ?address=` (address search) or `?latitude=&longitude=[&name=]` (nearby listings). */
export type OwnerLookup =
  | { kind: 'address'; address: string }
  | { kind: 'nearby'; latitude: number; longitude: number; name: string | null };

export function readOwnerLookup(params: URLSearchParams): OwnerLookup {
  if (params.toString().length > 1024) throw new OwnerInputError();
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new OwnerInputError();
  const sorted = [...keys].sort().join(',');
  if (sorted === 'address') {
    const address = (params.get('address') ?? '').trim().replace(/\s+/g, ' ');
    if ([...address].length < 3 || [...address].length > 200 || CONTROL.test(address)) throw new OwnerInputError();
    return { kind: 'address', address };
  }
  if (sorted === 'latitude,longitude' || sorted === 'latitude,longitude,name') {
    const coordinate = (key: string) => {
      const value = params.get(key) ?? '';
      if (!/^-?\d{1,3}(?:\.\d{1,8})?$/.test(value)) throw new OwnerInputError();
      return Number(value);
    };
    const latitude = coordinate('latitude');
    const longitude = coordinate('longitude');
    if (!inSubmissionBounds(latitude, longitude)) throw new OwnerInputError();
    const name = params.has('name') ? text(params.get('name'), 120, 'venue name') : null;
    return { kind: 'nearby', latitude, longitude, name };
  }
  throw new OwnerInputError();
}
