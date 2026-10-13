import type { VenueClaimStatus, VenuePublicationStatus } from './directory.ts';
import { isUuid } from './owner.ts';
import { PrelaunchInputError, type RegistrationRole } from './prelaunch.ts';
import type { ReviewCursor } from './review.ts';

// Pre-launch registrations in the console (T54b): administrators list them with the registrants' contact
// details, send fresh claim codes (usually at launch) and erase them for spam or a removal request.

export const REGISTRATION_STATUSES = ['open', 'claimed', 'erased'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];
/** Registrations one console request may send codes to or erase. Sends run one after another. */
export const MAX_REGISTRATION_BATCH = 25;
export const MAX_REGISTRATION_BATCH_BYTES = 8 * 1024;

/** One row of `prelaunch_admin_read` (admins only). */
export type AdminRegistration = {
  id: string;
  status: RegistrationStatus;
  registered_at: string;
  role: RegistrationRole;
  venue: { id: string; name: string; city: string; province: string; publication_status: VenuePublicationStatus; claim_status: VenueClaimStatus; court_count: number };
  /** Null once erased. */
  contact: { owner_name: string; email: string; phone: string | null; note: string | null } | null;
  code_version: number;
  email_sent_at: string | null;
  /** The code version the last delivered email carried: behind `code_version` when the newest code wasn't delivered. */
  email_sent_version: number | null;
  claimed_at: string | null;
  /** The ownership review item a claimed registration became. */
  submission_id: string | null;
  erased_at: string | null;
};
export type AdminRegistrationPage = { items: AdminRegistration[]; next_cursor: ReviewCursor | null; counts: Record<RegistrationStatus, number> };

/** `prelaunch_admin_rotate`: what the console needs to email the new code (service role only). */
export type RegistrationRotateResult = { outcome: 'rotated'; registration_id: string; code_version: number; owner_name: string; email: string; venue_name: string };
export type RegistrationEraseResult = { outcome: 'erased' | 'existing'; registration_id: string; listing_suspended: boolean };

/** `code_version` is the version the admin saw, so a double send or a stale page is refused. */
export type RegistrationSendItem = { id: string; code_version: number };
export type RegistrationAction = 'send' | 'erase';
export type RegistrationOutcome = { id: string; done: boolean; message: string | null };
export type RegistrationBatchResult = { action: RegistrationAction; outcomes: RegistrationOutcome[] };

/** True when the newest code went out by email (after a failed send the earlier code no longer works). */
export function codeDelivered(item: Pick<AdminRegistration, 'code_version' | 'email_sent_version'>): boolean {
  return item.email_sent_version === item.code_version;
}

/** The list's `?status=` tab; anything else is All. */
export function readRegistrationStatus(value: unknown): RegistrationStatus | null {
  return REGISTRATION_STATUSES.find((status) => status === value) ?? null;
}

/** The list's exact-address search: null when blank, an error when it can't be an address. */
export function readRegistrationEmailFilter(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new PrelaunchInputError('Enter a full email address.');
  const email = value.trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PrelaunchInputError('Enter a full email address.');
  return email;
}

function items(raw: unknown, key: 'items' | 'ids'): unknown[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).join() !== key) throw new PrelaunchInputError('Choose registrations and try again.');
  const list = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(list) || list.length === 0) throw new PrelaunchInputError('Choose registrations and try again.');
  if (list.length > MAX_REGISTRATION_BATCH) throw new PrelaunchInputError(`Choose up to ${MAX_REGISTRATION_BATCH} registrations at a time.`);
  return list;
}

function id(value: unknown, seen: Set<string>): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new PrelaunchInputError('Choose registrations and try again.');
  const lower = value.toLowerCase();
  if (seen.has(lower)) throw new PrelaunchInputError('Choose each registration once.');
  seen.add(lower);
  return lower;
}

/** `POST /api/console/registrations/send` body: `{items: [{id, code_version}]}`. */
export function readRegistrationSend(raw: unknown): RegistrationSendItem[] {
  const seen = new Set<string>();
  return items(raw, 'items').map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item) || Object.keys(item).sort().join() !== 'code_version,id') {
      throw new PrelaunchInputError('Choose registrations and try again.');
    }
    const { id: value, code_version } = item as Record<string, unknown>;
    if (!Number.isInteger(code_version) || (code_version as number) < 1 || (code_version as number) > 1000) throw new PrelaunchInputError('Reload the list and try again.');
    return { id: id(value, seen), code_version: code_version as number };
  });
}

/** `POST /api/console/registrations/erase` body: `{ids: [...]}`. */
export function readRegistrationErase(raw: unknown): string[] {
  const seen = new Set<string>();
  return items(raw, 'ids').map((value) => id(value, seen));
}
