import type { AttemptStore } from './attempt';
const values = new Map<string, string>();
export const attemptStore: AttemptStore = { get: async (key) => values.get(key) ?? null,
  set: async (key, value) => { values.set(key, value); }, remove: async (key) => { values.delete(key); } };
