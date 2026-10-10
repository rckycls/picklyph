import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { MenuRow } from '@/features/account/Menu';

import { bookingAlertsLabel, type PushState } from './pushClient';
import { syncThisDevice } from './pushLive';

/**
 * Account → Settings → **Booking alerts**. Shows whether this phone gets booking pushes and opens the
 * Booking alerts screen, which explains alerts before iOS asks and holds the account's switches (T45).
 */
export function BookingAlertsRow({ actor }: { actor: string }) {
  const [state, setState] = useState<PushState | null>(null);
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
  const label = bookingAlertsLabel(state);
  return (
    <MenuRow icon="bell" tone="lime" title="Booking alerts" subtitle={label} accessibilityLabel={`Booking alerts. ${label}`}
      onPress={() => router.push('/notifications')} />
  );
}
