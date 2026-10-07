import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { RentalFailure, RentalOutcome } from './client';

/** Focus/foreground reads invalidate earlier pages/results. Errors retain details, but never authorize an action. */
export function useRentalRead<T>(read: (signal: AbortSignal) => Promise<RentalOutcome<T>>, refreshSeconds?: number) {
  const [value, setValue] = useState<T | null>(null);
  const [failure, setFailure] = useState<RentalFailure | null>(null);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(() => { setBusy(true); setRevision((v) => v + 1); }, []);
  useFocusEffect(useCallback(() => {
    void revision; // Manual/foreground/timed refresh invalidates an earlier read.
    const controller = new AbortController(); const version = ++generation.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (retrySeconds = 0) => { if (refreshSeconds) timer = setTimeout(refresh, Math.max(refreshSeconds, retrySeconds) * 1000); };
    setBusy(true); setFailure(null);
    void read(controller.signal).then((result) => {
      if (controller.signal.aborted || version !== generation.current) return;
      if (result.ok) setValue(result.value); else setFailure(result.failure);
      setBusy(false);
      schedule(result.ok ? 0 : result.failure.retryAfterSeconds ?? 0);
    }).catch(() => {
      if (!controller.signal.aborted && version === generation.current) { setFailure({ kind: 'unavailable', retryAfterSeconds: null }); setBusy(false); schedule(); }
    });
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => { controller.abort(); generation.current++; listener.remove(); if (timer) clearTimeout(timer); };
  }, [read, revision, refresh, refreshSeconds]));
  return { value, failure, busy, refresh };
}
