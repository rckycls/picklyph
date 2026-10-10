import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { PushDeviceRegister, PushDeviceUnregister } from '../../../packages/domain/src/notification.ts';
import { PUSH_DEVICE_STATUS, PushDeviceRejected } from './handler.ts';
export function createSupabasePushDeviceDeps(verifier: () => SupabaseClient<Database>, server: () => SupabaseClient<Database>) {
  return {
    verifyUser: async (token: string): Promise<string | null> => {
      const { data, error } = await verifier().auth.getUser(token);
      if (error) {
        if ([400, 401, 403].includes(error.status ?? 0)) return null;
        throw new Error('Auth unavailable');
      }
      return data.user?.id ?? null;
    },
    register: async (actor: string, command: PushDeviceRegister) => {
      const { data, error } = await server().rpc('push_device_register', { actor_user_id: actor, device_input: { token: command.token, platform: command.platform } });
      if (error?.hint && PUSH_DEVICE_STATUS[error.hint]) throw new PushDeviceRejected(error.hint);
      if (error || data?.status !== 'registered') throw new Error('Registration unavailable');
    },
    unregister: async (actor: string, command: PushDeviceUnregister) => {
      const { data, error } = await server().rpc('push_device_unregister', { actor_user_id: actor, device_input: { token: command.token } });
      if (error?.hint && PUSH_DEVICE_STATUS[error.hint]) throw new PushDeviceRejected(error.hint);
      if (error || data?.status !== 'removed') throw new Error('Registration unavailable');
    },
  };
}
