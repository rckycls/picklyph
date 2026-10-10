import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { getSupabase } from '@/lib/supabase';

import { createRegistrationMemo, syncPushRegistration, type AlertPermission, type PushPorts, type PushState } from './pushClient';

type Notifications = typeof import('expo-notifications');
let loaded: Promise<Notifications | null> | null = null;

/**
 * expo-notifications needs native code that older development builds lack, and its modules throw
 * when imported there. Load it lazily so those builds keep working and report push as unavailable.
 */
function notifications(): Promise<Notifications | null> {
  loaded ??= import('expo-notifications').then((module) => {
    // Push is supplementary: while the app is open, show the banner and list entry quietly.
    module.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
    return module;
  }).catch(() => null);
  return loaded;
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

/** Calls `onChange` when iOS hands the app a new push token, after forgetting earlier registrations. */
export async function watchPushToken(onChange: () => void): Promise<{ remove: () => void } | null> {
  const module = await notifications();
  if (!module) return null;
  try { return module.addPushTokenListener(() => { memo.clear(); onChange(); }); } catch { return null; }
}
