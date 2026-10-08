/** Pure profile display rules. No app imports, so node tests load this file directly. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Apple's relay addresses are random strings, not names.
const RELAY = /@privaterelay\.appleid\.com$/i;
const MAX_NAME = 80;

const MAX_PERSON_NAME = 50;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** First and last name together, or null when neither is set. */
export function fullName(first: string | null | undefined, last: string | null | undefined): string | null {
  return [first, last].map((part) => part?.trim()).filter(Boolean).join(' ') || null;
}

/** Saved display name first, then first and last name, then a readable guess from the email's local part. */
export function profileName(displayName: string | null, email: string | null | undefined,
  first?: string | null, last?: string | null): string {
  const saved = displayName?.trim() || fullName(first, last);
  if (saved) return saved;
  const local = email && !RELAY.test(email) ? email.split('@')[0] ?? '' : '';
  const words = local.split(/[._+-]+/).map((word) => word.replace(/\d+/g, '')).filter(Boolean);
  if (!words.length) return 'Pickly player';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const picked = words.length > 1 ? [...words.slice(0, 1), ...words.slice(-1)] : words;
  return picked.map((word) => Array.from(word)[0] ?? '').join('').toUpperCase();
}

export function memberSince(iso: string | null | undefined): string | null {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** Matches the profiles check: trimmed, 1-80 characters, or null to clear. */
export function displayNameInput(value: string): Parsed<string | null> {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (Array.from(trimmed).length > MAX_NAME) return { ok: false, message: `Use ${MAX_NAME} characters or fewer.` };
  return { ok: true, value: trimmed };
}

/** First or last name: trimmed, single-spaced, 1-50 characters, or null to clear. */
export function personNameInput(value: string): Parsed<string | null> {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return { ok: true, value: null };
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, message: 'Use letters, spaces and punctuation only.' };
  if (Array.from(trimmed).length > MAX_PERSON_NAME) return { ok: false, message: `Use ${MAX_PERSON_NAME} characters or fewer.` };
  return { ok: true, value: trimmed };
}

/** Philippine mobile numbers, typed any common way, stored as +639XXXXXXXXX. Empty clears it. */
export function phoneInput(value: string): Parsed<string | null> {
  const compact = value.replace(/[\s().-]/g, '');
  if (!compact) return { ok: true, value: null };
  const match = /^(?:\+?63|0)?(9\d{9})$/.exec(compact);
  if (!match) return { ok: false, message: 'Enter a Philippine mobile number, like 0917 123 4567.' };
  return { ok: true, value: `+63${match[1]}` };
}

/** +639171234567 → +63 917 123 4567. Anything else is shown as stored. */
export function formatPhone(phone: string): string {
  const match = /^\+63(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `+63 ${match[1]} ${match[2]} ${match[3]}` : phone;
}

/** Keeps the last two digits: +63 *** *** **67. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length < 4 ? '********' : `+63 *** *** **${digits.slice(-2)}`;
}

/** Keeps the first character and the domain; the rest of the name becomes six asterisks. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '******';
  return `${Array.from(email)[0]}******${email.slice(at)}`;
}

/** Device-side precheck for a profile photo; Storage enforces the same type and size limits. */
export function avatarProblem(file: { uri: string; mimeType?: string | null; fileSize?: number | null }): { type: 'image/jpeg' | 'image/png' } | { problem: string } {
  const extension = /\.(jpe?g|png)$/i.exec(file.uri)?.[1]?.toLowerCase();
  const type = file.mimeType?.toLowerCase() ?? (extension === 'png' ? 'image/png' : extension ? 'image/jpeg' : undefined);
  if (type !== 'image/jpeg' && type !== 'image/png') return { problem: 'Choose a JPEG or PNG photo.' };
  if (typeof file.fileSize === 'number' && file.fileSize > MAX_AVATAR_BYTES) return { problem: 'That photo is larger than 5 MB. Choose a smaller photo.' };
  return { type };
}
