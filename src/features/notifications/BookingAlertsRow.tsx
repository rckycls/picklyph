import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';

import { MenuRow } from '@/features/account/Menu';

import { bookingAlertsLabel, type PushState } from './pushClient';
import { syncThisDevice } from './pushLive';

/**
 * Account → Settings → **Booking alerts**. Shows whether this phone gets booking pushes; a tap asks
 * for permission (first time), opens Settings (when denied) or retries a failed registration.
 */
export function BookingAlertsRow({ actor }: { actor: string }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => {
    let active = true;
    void syncThisDevice(actor, false).then((next) => { if (active) setState(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [actor]);
  useFocusEffect(read);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => { if (next === 'active') read(); });
    return () => listener.remove();
  }, [read]);
  const press = () => {
    if (busy || !state || state.permission === 'unavailable') return;
    if (state.permission === 'denied') { void Linking.openSettings().catch(() => undefined); return; }
    setBusy(true);
    void syncThisDevice(actor, true).then(setState).catch(() => undefined).finally(() => setBusy(false));
  };
  const label = bookingAlertsLabel(state);
  return (
    <MenuRow icon="bell" tone="lime" title="Booking alerts" subtitle={label} loading={busy}
      accessibilityLabel={`Booking alerts. ${label}`}
      onPress={state?.status === 'registered' || state?.permission === 'unavailable' ? undefined : press} />
  );
}
