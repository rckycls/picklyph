export interface SecureDriver {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

type Manifest = { version: 1; generation: string; count: number };

function manifest(value: string | null): Manifest | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed)
    || parsed.version !== 1 || !('generation' in parsed)
    || typeof parsed.generation !== 'string' || !/^[a-z0-9-]+$/i.test(parsed.generation)
    || !('count' in parsed) || !Number.isInteger(parsed.count)
    || typeof parsed.count !== 'number' || parsed.count < 1 || parsed.count > 128) {
    throw new Error('Stored session is unreadable.');
  }
  return { version: 1, generation: parsed.generation, count: parsed.count };
}

/** SecureStore has platform payload limits; commit a manifest only after all chunks. */
export function createSecureStorage(driver: SecureDriver, uniqueId: () => string): SecureDriver {
  let pending: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation, operation);
    pending = next.catch(() => undefined);
    return next;
  };
  const chunkKey = (key: string, entry: Manifest, index: number) =>
    `${key}.${entry.generation}.${index}`;
  const clearChunks = (key: string, entry: Manifest | null) => entry
    ? Promise.allSettled(Array.from({ length: entry.count }, (_, i) => driver.removeItem(chunkKey(key, entry, i))))
    : Promise.resolve([]);

  return {
    getItem: (key) => serialized(async () => {
      const entry = manifest(await driver.getItem(key));
      if (!entry) return null;
      const chunks = await Promise.all(Array.from({ length: entry.count }, (_, i) => driver.getItem(chunkKey(key, entry, i))));
      if (chunks.some((value) => value === null)) throw new Error('Stored session is incomplete.');
      return chunks.join('');
    }),
    setItem: (key, value) => serialized(async () => {
      const previous = manifest(await driver.getItem(key));
      // Unicode code points keep surrogate pairs together; each chunk is <= 2KB.
      const points = Array.from(value);
      const entry: Manifest = { version: 1, generation: uniqueId(), count: Math.max(1, Math.ceil(points.length / 500)) };
      if (entry.count > 128) throw new Error('Session exceeds secure storage capacity.');
      try {
        for (let i = 0; i < entry.count; i++) {
          await driver.setItem(chunkKey(key, entry, i), points.slice(i * 500, (i + 1) * 500).join(''));
        }
        await driver.setItem(key, JSON.stringify(entry));
      } catch (error) {
        await clearChunks(key, entry);
        throw error;
      }
      await clearChunks(key, previous);
    }),
    removeItem: (key) => serialized(async () => {
      const stored = await driver.getItem(key);
      let entry: Manifest | null = null;
      try { entry = manifest(stored); } catch { /* Remove unreadable manifests too. */ }
      await driver.removeItem(key);
      // Removing the manifest first prevents an interrupted cleanup restoring a session.
      await clearChunks(key, entry);
    }),
  };
}
