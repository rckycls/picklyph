import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { createSecureStorage } from './secureStorage';

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
export const sessionStorage = createSecureStorage({
  getItem: (key) => SecureStore.getItemAsync(key, options),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, options),
  removeItem: (key) => SecureStore.deleteItemAsync(key, options),
}, Crypto.randomUUID);
