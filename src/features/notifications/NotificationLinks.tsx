import { router, useRootNavigationState } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { useOwnerMode } from '@/features/owner/OwnerMode';

import { createLinkStore, linkNotice, nextLinkStep } from './links';
import { watchNotificationTaps } from './pushLive';

// Outlives the account-keyed Owner mode provider, so a link survives signing in.
const store = createLinkStore();

/**
 * Opens the booking screen for a tapped push (T44), only for the account it was sent to. Owner links
 * switch to Owner mode once venue access is confirmed. Mount once inside OwnerModeProvider.
 */
export function NotificationLinks() {
  const auth = useAuth();
  const { count, error, setMode } = useOwnerMode();
  const ready = Boolean(useRootNavigationState()?.key);
  const link = useSyncExternalStore(store.subscribe, store.get);
  const user = auth.status === 'ready' ? auth.session?.user.id ?? null : null;

  useEffect(() => {
    let active = true;
    let watch: { remove: () => void } | null = null;
    void watchNotificationTaps((data) => { store.offer(data, Date.now()); }).then((next) => { if (active) watch = next; else next?.remove(); });
    return () => { active = false; watch?.remove(); };
  }, []);

  useEffect(() => {
    if (!link || !ready) return;
    const step = nextLinkStep(link, { status: auth.status, user }, { count, error }, Date.now());
    if (step.kind === 'wait') return;
    if (step.kind === 'sign_in') {
      if (link.prompted) return;
      store.markPrompted(link);
      router.navigate('/account');
    } else {
      store.finish(link);
      if (step.kind === 'open') {
        if (step.owner) setMode('owner');
        router.push(step.target);
        return;
      }
    }
    const notice = linkNotice(step);
    if (notice) Alert.alert(notice.title, notice.body);
  }, [link, ready, auth.status, user, count, error, setMode]);

  return null;
}
