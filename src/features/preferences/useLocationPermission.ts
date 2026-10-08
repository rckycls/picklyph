import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { readForegroundPermission, type PermissionSnapshot } from '@/lib/location';

/** Current location permission, re-read on focus and on return from Settings. Never prompts. */
export function useLocationPermission(): PermissionSnapshot | null {
  const [permission, setPermission] = useState<PermissionSnapshot | null>(null);
  const read = useCallback(() => {
    let active = true;
    void readForegroundPermission().then((next) => { if (active) setPermission(next); });
    return () => { active = false; };
  }, []);
  useFocusEffect(read);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') read(); });
    return () => listener.remove();
  }, [read]);
  return permission;
}

/** Plain-language status for the Location access row. */
export function locationAccessLabel(permission: PermissionSnapshot | null): string {
  if (!permission) return 'Checking…';
  switch (permission.status) {
    case 'granted': return 'Allowed · used to show courts near you';
    case 'disabled': return 'Location Services are off · open Settings';
    case 'denied': return permission.canAskAgain ? 'Not set · Discover asks when you tap Use my location' : 'Off · open Settings to allow';
    case 'unavailable': return 'Unavailable on this device';
  }
}
