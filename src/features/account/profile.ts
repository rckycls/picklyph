/** Pure profile display rules. No app imports, so node tests load this file directly. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Apple's relay addresses are random strings, not names.
const RELAY = /@privaterelay\.appleid\.com$/i;
const MAX_NAME = 80;

/** Saved name first, then a readable guess from the email's local part. */
export function profileName(displayName: string | null, email: string | null | undefined): string {
  const saved = displayName?.trim();
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

export function signInMethod(provider: unknown): string | null {
  if (provider === 'apple') return 'Apple';
  if (provider === 'email') return 'Email code';
  return null;
}

/** Matches the profiles check: trimmed, 1-80 characters, or null to clear. */
export function displayNameInput(value: string): { ok: true; value: string | null } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (Array.from(trimmed).length > MAX_NAME) return { ok: false, message: `Use ${MAX_NAME} characters or fewer.` };
  return { ok: true, value: trimmed };
}
