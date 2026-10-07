import { useEffect, useState } from 'react';
import type { RentalFailure } from './client';

/** Local time only schedules retry controls; it never decides booking/hold status. */
export function useRetryWait(failure: RentalFailure | null): number {
  const [tick, setTick] = useState<{ failure: RentalFailure | null; seconds: number }>({ failure: null, seconds: 0 });
  useEffect(() => {
    if (!failure?.retryAfterSeconds) return;
    const until = Date.now() + failure.retryAfterSeconds * 1000;
    const timer = setInterval(() => {
      const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setTick({ failure, seconds });
      if (!seconds) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [failure]);
  return tick.failure === failure ? tick.seconds : failure?.retryAfterSeconds ?? 0;
}
