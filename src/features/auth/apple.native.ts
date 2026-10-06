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
