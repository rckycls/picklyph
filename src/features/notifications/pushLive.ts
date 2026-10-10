import Constants from 'expo-constants';
import type { NotificationResponse } from 'expo-notifications';
import { Platform } from 'react-native';

import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { getSupabase } from '@/lib/supabase';

import type { NotificationTopic } from '@picklyph/domain';

import { createRegistrationMemo, readAlertPreferences, releasePushRegistration, saveAlertPreferences, shouldPresent, syncPushRegistration,
  type AlertPermission, type PushPorts, type PushState, type ReleaseOutcome } from './pushClient';

type Notifications = typeof import('expo-notifications');
let loaded: Promise<Notifications | null> | null = null;
/** The signed-in account, kept by `PushRegistration`; null while signed out. */
let signedIn: string | null = null;

/**
 * expo-notifications needs native code that older development builds lack, and its modules throw
 * when imported there. Load it lazily so those builds keep working and report push as unavailable.
 */
function notifications(): Promise<Notifications | null> {
  loaded ??= import('expo-notifications').then((module) => {
    // Push is supplementary: while the app is open, show the banner and list entry quietly, and only
    // for the signed-in account (T45), so a phone that changed accounts never shows another one's.
    module.setNotificationHandler({ handleNotification: async (notification) => {
      const show = shouldPresent(notification.request.content.data, signedIn);
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: false, shouldSetBadge: false };
    } });
    return module;
  }).catch(() => null);
  return loaded;
}

export function setAlertRecipient(actor: string | null) {
  signedIn = actor;
}

const readPermission = (status: { granted: boolean; status: string; ios?: { status?: number } }): AlertPermission => {
  if (status.granted) return 'granted';
  return status.status === 'undetermined' ? 'undetermined' : 'denied';
};

const backend = () => process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
const memo = createRegistrationMemo();

const ports: PushPorts = {
  get backend() { return backend(); },
  platform: Platform.OS === 'android' ? 'android' : 'ios',
  permission: async () => {
    const module = await notifications();
    if (!module) return 'unavailable';
    try { return readPermission(await module.getPermissionsAsync()); } catch { return 'unavailable'; }
  },
  request: async () => {
    const module = await notifications();
    if (!module) return 'unavailable';
    try { return readPermission(await module.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: true } })); }
    catch { return 'unavailable'; }
  },
  token: async () => {
    const module = await notifications();
    const projectId = Constants.easConfig?.projectId ?? (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId;
    if (!module || !projectId) return null;
    try { return (await module.getExpoPushTokenAsync({ projectId })).data; } catch { return null; }
  },
  // The bearer must still belong to the account being registered; otherwise nothing is sent.
  transport: (actor) => ({
    endpoint: `${backend()}/functions/v1/push-devices`, apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '',
    accessToken: async () => {
      const { data, error } = await getSupabase().auth.getSession();
      return !error && data.session?.user.id === actor ? data.session.access_token : null;
    },
    fetch: fetchWithDeadline,
  }),
};

/** Registers this phone for the signed-in account when notifications are allowed; `ask` may show the system prompt. */
export async function syncThisDevice(actor: string, ask: boolean): Promise<PushState> {
  if (!backend()) return { permission: 'unavailable', status: 'off' };
  return syncPushRegistration(ports, memo, actor, ask);
}

/** Reads the notification permission only: no prompt, no registration. */
export function alertPermission(): Promise<AlertPermission> {
  return backend() ? ports.permission() : Promise.resolve('unavailable');
}

/** Sign-out, step one: removes this phone from `actor`'s alerts and holds registration until `endRelease`. */
export async function releaseThisDevice(actor: string): Promise<ReleaseOutcome> {
  if (!backend()) return { status: 'none' };
  return releasePushRegistration(ports, memo, actor);
}

/** After sign-out finished or was abandoned; an abandoned one registers again on the next check. */
export function endRelease(actor: string) {
  memo.unhold(backend(), actor);
}

export function alertPreferences(actor: string) {
  return {
    read: (signal?: AbortSignal) => readAlertPreferences(ports.transport(actor), signal),
    save: (muted: NotificationTopic[]) => saveAlertPreferences(ports.transport(actor), muted),
  };
}

/**
 * Calls `onTap` with the data of each push the user opens (T44): the one that launched the app, then
 * later ones. The launch response is cleared once read, so it is not reported again.
 */
export async function watchNotificationTaps(onTap: (data: unknown) => void): Promise<{ remove: () => void } | null> {
  const module = await notifications();
  if (!module) return null;
  try {
    const take = (response: NotificationResponse | null) => {
      if (!response || response.actionIdentifier !== module.DEFAULT_ACTION_IDENTIFIER) return;
      onTap(response.notification.request.content.data);
    };
    const subscription = module.addNotificationResponseReceivedListener(take);
    const launch = module.getLastNotificationResponse();
    if (launch) { module.clearLastNotificationResponse(); take(launch); }
    return subscription;
  } catch { return null; }
}

/** Calls `onChange` when iOS hands the app a new push token, after forgetting earlier registrations. */
export async function watchPushToken(onChange: () => void): Promise<{ remove: () => void } | null> {
  const module = await notifications();
  if (!module) return null;
  try { return module.addPushTokenListener(() => { memo.clear(); onChange(); }); } catch { return null; }
}
