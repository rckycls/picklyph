import { useRef, useState } from 'react';
import { Alert } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';

import { releaseFailureMessage } from './pushClient';
import { endRelease, releaseThisDevice, syncThisDevice } from './pushLive';

type Choice = 'retry' | 'anyway' | 'stay';
const ask = (message: string) => new Promise<Choice>((resolve) => Alert.alert('Booking alerts are still on', message, [
  { text: 'Try again', onPress: () => resolve('retry') },
  { text: 'Sign out anyway', style: 'destructive', onPress: () => resolve('anyway') },
  { text: 'Stay signed in', style: 'cancel', onPress: () => resolve('stay') },
], { cancelable: true, onDismiss: () => resolve('stay') }));

/**
 * Sign-out that first removes this phone from the account's booking alerts (T45). When that can't be
 * confirmed, the person chooses to try again, sign out anyway or stay signed in. Registration is held
 * the whole time, so returning to the app mid sign-out never re-registers the phone.
 */
export function useAlertSignOut(actor: string) {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const finish = async () => {
    try { await auth.signOut(); }
    catch {
      setError('We couldn’t sign out. Please try again.');
      endRelease(actor);
      // Still signed in, so this phone gets the account's alerts again.
      void syncThisDevice(actor, false).catch(() => undefined);
      return;
    }
    endRelease(actor);
  };

  const signOut = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null);
    try {
      for (;;) {
        const release = await releaseThisDevice(actor).catch(() => ({ status: 'failed' as const, failure: null }));
        if (release.status !== 'failed') { await finish(); return; }
        const choice = await ask(releaseFailureMessage(release.failure));
        if (choice === 'retry') continue;
        if (choice === 'anyway') { await finish(); return; }
        endRelease(actor);
        void syncThisDevice(actor, false).catch(() => undefined);
        return;
      }
    } finally { running.current = false; setBusy(false); }
  };

  return { signOut, busy: busy || auth.busy, error };
}
