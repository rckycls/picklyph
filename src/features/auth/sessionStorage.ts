// Metro selects native secure storage or the nonpersistent web fallback.
const memory = new Map<string, string>();
export const sessionStorage = {
  getItem: async (key: string) => memory.get(key) ?? null,
  setItem: async (key: string, value: string) => { memory.set(key, value); },
  removeItem: async (key: string) => { memory.delete(key); },
};
