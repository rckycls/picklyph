import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';

import { syncThisDevice, watchPushToken } from './pushLive';

/**
 * Keeps this phone registered for the signed-in account (T43): on sign-in, on return to the app and
 * when the push token changes. It never shows the permission prompt; the Account row asks.
 */
export function usePushRegistration() {
  const { session } = useAuth();
  const actor = session?.user.id ?? null;
  useEffect(() => {
    if (!actor) return;
    let active = true;
    const run = () => { if (active) void syncThisDevice(actor, false).catch(() => undefined); };
    run();
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') run(); });
    let tokenWatch: { remove: () => void } | null = null;
    void watchPushToken(run).then((watch) => { if (active) tokenWatch = watch; else watch?.remove(); });
    return () => { active = false; appState.remove(); tokenWatch?.remove(); };
  }, [actor]);
}

/** Mount once inside AuthProvider. */
export function PushRegistration() {
  usePushRegistration();
  return null;
}
