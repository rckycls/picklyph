import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { HttpFailure, HttpOutcome } from '../owner/venueClient';
import { createGeneration } from '../rental/model';

/** Cursor pages that restart at page one on focus, foreground and refresh; late replies from an earlier generation are dropped. */
export function usePages<P extends { next_cursor: string | null }, T, R extends string>(
  load: (after: string | null, signal: AbortSignal) => Promise<HttpOutcome<P, R>>,
  merge: (rows: T[], page: P, after: string | null) => T[],
) {
  const [rows, setRows] = useState<T[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false); const [busy, setBusy] = useState(false); const [failure, setFailure] = useState<HttpFailure<R> | null>(null);
  const [revision, setRevision] = useState(0); const generation = useRef(createGeneration()).current;
  const lock = useRef(false); const abort = useRef<AbortController | null>(null);
  const page = useCallback(async (after: string | null) => {
    if (lock.current) return;
    lock.current = true; const version = generation.next(); const controller = new AbortController(); abort.current = controller;
    setBusy(true); setFailure(null);
    try {
      const result = await load(after, controller.signal);
      if (controller.signal.aborted || !generation.current(version)) return;
      if (result.ok) { setRows((old) => merge(old, result.value, after)); setCursor(result.value.next_cursor); setLoaded(true); }
      else setFailure(result.failure);
    } catch { if (!controller.signal.aborted && generation.current(version)) setFailure({ kind: 'unavailable', retryAfterSeconds: null }); }
    finally { if (generation.current(version)) { lock.current = false; setBusy(false); } }
  }, [load, merge, generation]);
  const refresh = useCallback(() => { abort.current?.abort(); generation.next(); lock.current = false; setRevision((v) => v + 1); }, [generation]);
  useFocusEffect(useCallback(() => {
    void revision; // Refresh restarts at page one, including after foreground return.
    void page(null);
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => { abort.current?.abort(); generation.next(); lock.current = false; listener.remove(); };
  }, [page, revision, generation, refresh]));
  return { rows, cursor, loaded, busy, failure, refresh, more: () => { if (cursor) void page(cursor); } };
}
