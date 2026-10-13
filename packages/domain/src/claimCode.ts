// Pre-launch claim codes (T53 issues them, T54 redeems them). The registration server and the
// owner-submissions function hash with this one implementation, so a code emailed by one matches in the other.

/** No 0/O, 1/I/L or U: easy to read aloud and type. 30 symbols, 10 characters ≈ 49 bits. */
export const CLAIM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const CLAIM_CODE_LENGTH = 10;
/** Wrong codes an account may try within one window before it is locked out (the database decides). */
export const CLAIM_CODE_MAX_FAILURES = 5;
export const CLAIM_CODE_LOCKOUT_MINUTES = 60;

/** ABCDEFGHJK → ABCDE-FGHJK, as printed in the email. */
export function formatClaimCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** What someone typed (any case, spaces or dashes) → the canonical code, or null if it can't be one. */
export function normalizeClaimCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 40) return null;
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== CLAIM_CODE_LENGTH || [...code].some((symbol) => !CLAIM_CODE_ALPHABET.includes(symbol))) return null;
  return code;
}

/** A uniformly random claim code from the server's CSPRNG (rejection sampling keeps every symbol equally likely).
 * Servers only: the registration page and the console (T54b) issue codes; the app never does. */
export function generateClaimCode(random: (size: number) => Uint8Array = (size) => crypto.getRandomValues(new Uint8Array(size))): string {
  const limit = 256 - (256 % CLAIM_CODE_ALPHABET.length);
  let code = '';
  while (code.length < CLAIM_CODE_LENGTH) {
    for (const byte of random(16)) {
      if (byte < limit && code.length < CLAIM_CODE_LENGTH) code += CLAIM_CODE_ALPHABET[byte % CLAIM_CODE_ALPHABET.length];
    }
  }
  return code;
}

/** HMAC-SHA256 (hex) of the canonical code under PRELAUNCH_CODE_SECRET. Only this hash is ever stored or compared. */
export async function hashClaimCode(secret: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`pickly-claim-code:v1:${code}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
