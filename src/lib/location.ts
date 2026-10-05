export type Coordinates = { latitude: number; longitude: number };
type Permission = { granted: boolean; canAskAgain: boolean };

/** Small native boundary; injectable so permission/failure behavior can be checked off-device. */
export interface LocationClient {
  servicesEnabled(): Promise<boolean>;
  getPermission(): Promise<Permission>;
  requestPermission(): Promise<Permission>;
  recentPosition(): Promise<Coordinates | null>;
  currentPosition(): Promise<Coordinates>;
}

export type LocationResult =
  | { status: 'granted'; coordinates: Coordinates }
  | { status: 'denied'; canAskAgain: boolean }
  | { status: 'disabled' }
  | { status: 'unavailable' };

export type PermissionSnapshot = Exclude<LocationResult, { status: 'granted' }> | { status: 'granted' };

async function nativeClient(): Promise<LocationClient> {
  const location = await import('expo-location');
  return {
    servicesEnabled: location.hasServicesEnabledAsync,
    getPermission: location.getForegroundPermissionsAsync,
    requestPermission: location.requestForegroundPermissionsAsync,
    recentPosition: async () => {
      const result = await location.getLastKnownPositionAsync({ maxAge: 60_000, requiredAccuracy: 1_000 });
      return result?.coords ?? null;
    },
    currentPosition: async () => (await location.getCurrentPositionAsync({ accuracy: location.Accuracy.Balanced })).coords,
  };
}

/** Called only after the player presses the location button. No background subscription or persistence. */
export async function locateUser(client?: LocationClient, timeoutMs = 15_000): Promise<LocationResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const api = client ?? await nativeClient();
    if (!await api.servicesEnabled()) return { status: 'disabled' };
    let permission = await api.getPermission();
    if (!permission.granted && permission.canAskAgain) permission = await api.requestPermission();
    if (!permission.granted) return { status: 'denied', canAskAgain: permission.canAskAgain };

    // Bound position acquisition after the permission prompt; a late native result never changes the UI.
    const position = (async () => await api.recentPosition() ?? await api.currentPosition())();
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Location timed out')), timeoutMs);
    });
    const coordinates = await Promise.race([position, deadline]);
    if (!Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude)
      || Math.abs(coordinates.latitude) > 90 || Math.abs(coordinates.longitude) > 180) {
      return { status: 'unavailable' };
    }
    // Keep only the coordinates needed to center the map; never log or store them.
    return { status: 'granted', coordinates: { latitude: coordinates.latitude, longitude: coordinates.longitude } };
  } catch {
    return { status: 'unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Permission recheck when returning from Settings; this never displays a prompt. */
export async function readForegroundPermission(client?: LocationClient): Promise<PermissionSnapshot> {
  try {
    const api = client ?? await nativeClient();
    if (!await api.servicesEnabled()) return { status: 'disabled' };
    const permission = await api.getPermission();
    return permission.granted ? { status: 'granted' } : { status: 'denied', canAskAgain: permission.canAskAgain };
  } catch {
    return { status: 'unavailable' };
  }
}
