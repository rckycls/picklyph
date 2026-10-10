import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';

import type { ApplePort } from './actions';

export const applePort: ApplePort = {
  nonce: Crypto.randomUUID,
  hash: (nonce) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce),
  signIn: async (nonce) => {
    const credential = await AppleAuthentication.signInAsync({
      nonce,
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL, AppleAuthentication.AppleAuthenticationScope.FULL_NAME],
    });
    return {
      identityToken: credential.identityToken,
      fullName: [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ') || undefined,
    };
  },
};

/**
 * T50a: a fresh, single-use authorization code from the person's Apple ID, so the server can revoke the app's Apple tokens
 * when the account is deleted. `null` when the person closes Apple's sheet. The code is only ever sent with that request.
 */
export async function appleAuthorizationCode(): Promise<string | null> {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try { credential = await AppleAuthentication.signInAsync({ requestedScopes: [] }); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_REQUEST_CANCELED') return null;
    throw new Error('Apple sign-in didn’t complete.');
  }
  if (!credential.authorizationCode) throw new Error('Apple did not return an authorization code.');
  return credential.authorizationCode;
}
