import AsyncStorage from '@react-native-async-storage/async-storage';

import type { DiscoveryView } from '@/features/discovery/FilterBar';

const KEY = 'pickly.discover.view.v1';

/** Which view Discover opens in. Installation-local; unreadable storage means the map. */
export async function loadDiscoverView(): Promise<DiscoveryView> {
  try { return (await AsyncStorage.getItem(KEY)) === 'list' ? 'list' : 'map'; }
  catch { return 'map'; }
}

export async function saveDiscoverView(view: DiscoveryView): Promise<void> {
  await AsyncStorage.setItem(KEY, view);
}
