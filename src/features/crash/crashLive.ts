import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { AppState, Platform } from 'react-native';

import type { CrashKind, CrashVariant } from '@picklyph/domain';

import { fetchWithDeadline } from '@/lib/fetchWithDeadline';

import { buildCrashReport, createCrashQueue, createRepeatFilter, installCrashHandler, type CrashApp } from './crashClient';

/** The current screen's path, kept by `CrashRoute`; normalized (IDs removed) when a report is made. */
let route: string | null = null;
export function setCrashRoute(pathname: string | null) {
  route = pathname;
}

// EAS profiles set APP_VARIANT and app.config.ts passes it on; Metro builds are development.
const variant = (): CrashVariant => {
  const value: unknown = Constants.expoConfig?.extra?.variant;
  return value === 'preview' || value === 'production' ? value : 'development';
};
const app = (): CrashApp => ({ version: Constants.expoConfig?.version ?? '0.0.0', variant: variant(),
  os: Platform.OS === 'android' ? 'android' : 'ios', osVersion: String(Platform.Version) });

// Anonymous: the public key only, never the signed-in account's token.
const queue = createCrashQueue({
  store: AsyncStorage,
  now: Date.now,
  send: async (report) => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
    const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
    if (!url || !key) return null;
    try {
      const response = await fetchWithDeadline(`${url}/functions/v1/crash-reports`, { method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify(report) }, 10_000);
      return response.status;
    } catch { return null; }
  },
});
const firstTime = createRepeatFilter(Date.now);

/** Saves one report; anything but a fatal error is sent right away. Never throws. */
export async function recordCrash(error: unknown, kind: CrashKind, componentStack?: string | null): Promise<void> {
  try {
    const report = buildCrashReport(error, kind, { route, componentStack }, app(), randomUUID(), Date.now());
    if (!report || !firstTime(report)) return;
    await queue.add(report);
    if (kind !== 'fatal') void queue.flush();
  } catch { /* Reporting must never cause a second failure. */ }
}

let started = false;
/** Once per app run: the global handler, then sending at launch and on every return to the foreground. */
export function startCrashReporting() {
  if (started) return;
  started = true;
  installCrashHandler(ErrorUtils, (error, fatal) => recordCrash(error, fatal ? 'fatal' : 'error'));
  setTimeout(() => void queue.flush(), 3000);
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void queue.flush();
  });
}
