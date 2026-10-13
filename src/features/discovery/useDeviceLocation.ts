import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { locateUser, readForegroundPermission, type LocationResult } from '@/lib/location';

export type DeviceLocation = LocationResult | { status: 'idle' } | { status: 'requesting' };

export function useDeviceLocation(onResult: (result: LocationResult) => void) {
  const [location, setLocation] = useState<DeviceLocation>({ status: 'idle' });
  const mounted = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const request = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLocation({ status: 'requesting' });
    const result = await locateUser();
    if (mounted.current) {
      setLocation(result);
      onResult(result);
    }
    busy.current = false;
  }, [onResult]);

  useEffect(() => {
    if (location.status === 'idle' || location.status === 'requesting') return;
    let active = true;
    const subscription = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      const permission = await readForegroundPermission();
      if (!active || !mounted.current || busy.current) return;
      if (permission.status === 'granted') {
        // Discover centers on the player whenever it may, so a permission granted in Settings is used on return.
        if (location.status !== 'granted') void request();
      } else {
        setLocation(permission);
        if (location.status === 'granted') onResult(permission);
      }
    });
    return () => { active = false; subscription.remove(); };
  }, [location.status, onResult, request]);

  return { location, request };
}
