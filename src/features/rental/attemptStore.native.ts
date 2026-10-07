import * as SecureStore from 'expo-secure-store';
import type { AttemptStore } from './attempt';
export const attemptStore: AttemptStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  remove: (key) => SecureStore.deleteItemAsync(key),
};
