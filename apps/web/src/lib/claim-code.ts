import { CLAIM_CODE_ALPHABET, CLAIM_CODE_LENGTH } from '@picklyph/domain/src/prelaunch.ts';

/** A uniformly random claim code from the server's CSPRNG (rejection sampling keeps every symbol equally likely). */
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

/** HMAC-SHA256 (hex) of the canonical code under PRELAUNCH_CODE_SECRET. Only this hash is stored. */
export async function hashClaimCode(secret: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`pickly-claim-code:v1:${code}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
