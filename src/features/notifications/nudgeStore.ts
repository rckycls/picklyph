import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'pickly.alerts.nudge.v1';

/** Whether "Not now" was chosen on this phone. Unreadable storage reads as dismissed, so the nudge never nags. */
export async function loadNudgeDismissed(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(KEY)) === 'dismissed'; }
  catch { return true; }
}

export async function dismissNudge(): Promise<void> {
  await AsyncStorage.setItem(KEY, 'dismissed');
}
