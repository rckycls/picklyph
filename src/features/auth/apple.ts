import type { ApplePort } from './actions';

export const applePort: ApplePort = {
  nonce: () => { throw new Error('Apple sign-in is available on iPhone.'); },
  hash: async () => { throw new Error('Apple sign-in is available on iPhone.'); },
  signIn: async () => { throw new Error('Apple sign-in is available on iPhone.'); },
};
