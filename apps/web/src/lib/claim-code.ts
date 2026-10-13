import { CLAIM_CODE_ALPHABET, CLAIM_CODE_LENGTH } from '@picklyph/domain/src/claimCode.ts';

// One HMAC for the registration server and the app's redemption (owner-submissions, T54).
export { hashClaimCode } from '@picklyph/domain/src/claimCode.ts';

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
