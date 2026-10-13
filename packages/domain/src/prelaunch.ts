import type { CourtSurface } from './directory.ts';
import { readOwnerNote, readOwnerVenueInput, isUuid, type OwnerDuplicate, type OwnerVenueInput } from './owner.ts';

export { CLAIM_CODE_ALPHABET, CLAIM_CODE_LENGTH, formatClaimCode, normalizeClaimCode } from './claimCode.ts';

// Pre-launch court registration (T53). The public page and its server read the same contract; the
// database (`prelaunch_register`) re-validates every field. Claim codes are redeemed in the app (T54).
export const MAX_PRELAUNCH_BODY = 8 * 1024;
export const MAX_OPEN_REGISTRATIONS_PER_EMAIL = 10;
/** Contact details and the code hash of unclaimed registrations are erased this long after the last code email. */
export const REGISTRATION_RETENTION_DAYS = 180;
/** A claimed registration's contact details are erased this long after the claim's review decision (T54). */
export const CLAIMED_REGISTRATION_RETENTION_DAYS = 30;
export const MAX_TURNSTILE_TOKEN = 2048;
export const REGISTRATION_ROLES = ['owner', 'manager', 'staff'] as const;
export const REGISTRATION_ROLE_LABELS: Record<RegistrationRole, string> = { owner: 'Owner', manager: 'Manager', staff: 'Staff' };
export const COURT_SURFACES: readonly CourtSurface[] = ['hard', 'synthetic', 'other'];

export type RegistrationRole = (typeof REGISTRATION_ROLES)[number];
/** Applied to every court; owners set each court up in the app after claiming. */
export type RegistrationCourts = { indoor: boolean; covered: boolean; surface: CourtSurface | null };
export type PrelaunchRegistration = {
  owner_name: string;
  email: string;
  /** +639XXXXXXXXX or null. */
  phone: string | null;
  role: RegistrationRole;
  venue: OwnerVenueInput;
  courts: RegistrationCourts;
  note: string | null;
  consent: true;
};
export type PrelaunchRequest = {
  request_key: string;
  turnstile_token: string;
  acknowledge_duplicates: boolean;
  registration: PrelaunchRegistration;
};
/** Approved public listing near the pin; drafts and other registrations are never shown. */
export type PrelaunchDuplicate = { name: string; address_line: string; city: string; distance_m: number };
/** `sent` is the same whether the address is new, registered before or at its limit. */
export type PrelaunchReply =
  | { status: 'sent'; venue_name: string }
  | { status: 'duplicates'; duplicates: PrelaunchDuplicate[] };
export type PrelaunchErrorReply = { error: string; message: string };
/** `prelaunch_register`: the server answers created, existing and limit identically (`sent`). */
export type PrelaunchRegisterResult = {
  outcome: 'created' | 'existing' | 'duplicates' | 'limit';
  registration_id: string | null;
  /** Send the code email: a new registration, or a retry whose earlier email never went out (the code rotated). */
  send: boolean;
  code_version: number | null;
  venue_name: string;
  duplicates: OwnerDuplicate[];
};

export class PrelaunchInputError extends Error {
  constructor(message = 'Check the form and try again.') { super(message); this.name = 'PrelaunchInputError'; }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function exactKeys(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).sort().join(',') !== [...keys].sort().join(',')) throw new PrelaunchInputError();
}

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new PrelaunchInputError();
  return raw as Record<string, unknown>;
}

export function readOwnerName(value: unknown): string {
  if (typeof value !== 'string') throw new PrelaunchInputError('Enter your name.');
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) throw new PrelaunchInputError('Enter your name.');
  if ([...name].length > 120 || CONTROL.test(name)) throw new PrelaunchInputError('Shorten your name to 120 characters.');
  return name;
}

export function readContactEmail(value: unknown): string {
  if (typeof value !== 'string') throw new PrelaunchInputError('Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || CONTROL.test(email) || !EMAIL.test(email)) {
    throw new PrelaunchInputError('Enter a valid email address.');
  }
  return email;
}

/** Philippine mobile numbers typed any common way, stored as +639XXXXXXXXX. Blank is null. */
export function readMobileNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new PrelaunchInputError('Enter a Philippine mobile number, like 0917 123 4567.');
  const compact = value.replace(/[\s().-]/g, '');
  if (!compact) return null;
  const match = /^(?:\+?63|0)?(9\d{9})$/.exec(compact);
  if (!match) throw new PrelaunchInputError('Enter a Philippine mobile number, like 0917 123 4567.');
  return `+63${match[1]}`;
}

export function readRegistrationRole(value: unknown): RegistrationRole {
  if (typeof value !== 'string' || !(REGISTRATION_ROLES as readonly string[]).includes(value)) {
    throw new PrelaunchInputError('Choose your role at the venue.');
  }
  return value as RegistrationRole;
}

export function readRegistrationCourts(raw: unknown): RegistrationCourts {
  const input = object(raw);
  exactKeys(input, ['indoor', 'covered', 'surface']);
  if (typeof input.indoor !== 'boolean' || typeof input.covered !== 'boolean'
    || !(input.surface === null || (typeof input.surface === 'string' && (COURT_SURFACES as readonly string[]).includes(input.surface)))) {
    throw new PrelaunchInputError('Check the court details.');
  }
  return { indoor: input.indoor, covered: input.covered, surface: input.surface as CourtSurface | null };
}

export function readPrelaunchRegistration(raw: unknown): PrelaunchRegistration {
  const input = object(raw);
  exactKeys(input, ['owner_name', 'email', 'phone', 'role', 'venue', 'courts', 'note', 'consent']);
  if (input.consent !== true) throw new PrelaunchInputError('Agree to the privacy notice to register.');
  let venue: OwnerVenueInput;
  let note: string | null;
  try {
    venue = readOwnerVenueInput(input.venue);
    note = readOwnerNote(input.note);
  } catch (error) {
    throw new PrelaunchInputError(error instanceof Error && error.message !== 'Invalid owner submission.' ? error.message : undefined);
  }
  return {
    owner_name: readOwnerName(input.owner_name), email: readContactEmail(input.email), phone: readMobileNumber(input.phone),
    role: readRegistrationRole(input.role), venue, courts: readRegistrationCourts(input.courts), note, consent: true,
  };
}

/** The JSON body of `POST /api/register`. */
export function readPrelaunchRequest(raw: unknown): PrelaunchRequest {
  const input = object(raw);
  exactKeys(input, ['request_key', 'turnstile_token', 'acknowledge_duplicates', 'registration']);
  if (!isUuid(input.request_key) || typeof input.acknowledge_duplicates !== 'boolean') throw new PrelaunchInputError();
  if (typeof input.turnstile_token !== 'string' || input.turnstile_token.length < 1
    || input.turnstile_token.length > MAX_TURNSTILE_TOKEN || CONTROL.test(input.turnstile_token)) {
    throw new PrelaunchInputError('Complete the check above the button, then try again.');
  }
  return {
    request_key: input.request_key.toLowerCase(), turnstile_token: input.turnstile_token,
    acknowledge_duplicates: input.acknowledge_duplicates, registration: readPrelaunchRegistration(input.registration),
  };
}

/** The JSON body of `POST /api/address`. */
export function readAddressQuery(raw: unknown): string {
  const input = object(raw);
  exactKeys(input, ['query']);
  if (typeof input.query !== 'string') throw new PrelaunchInputError('Enter an address to search.');
  const query = input.query.trim().replace(/\s+/g, ' ');
  if ([...query].length < 3 || [...query].length > 200 || CONTROL.test(query)) {
    throw new PrelaunchInputError('Enter 3 to 200 characters to search.');
  }
  return query;
}
