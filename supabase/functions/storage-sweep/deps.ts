import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { readStorageSweepConfirm, readStorageSweepDue, type StorageSweepBucket, type StorageSweepItem } from '../../../packages/domain/src/storageSweep.ts';

/** The service-only sweep commands and Storage API removal. Supabase refuses direct deletes from storage.objects. */
export function createSupabaseStorageSweepDeps(server: () => SupabaseClient<Database>) {
  return {
    due: async (batch: number) => {
      const { data, error } = await server().rpc('storage_sweep_due', { batch_limit: batch });
      if (error) throw new Error('Storage sweep unavailable');
      return readStorageSweepDue(data);
    },
    remove: async (bucket: StorageSweepBucket, paths: string[]) => {
      const { data, error } = await server().storage.from(bucket).remove(paths);
      if (error || !Array.isArray(data)) throw new Error('Storage refused');
      return data.length;
    },
    confirm: async (items: StorageSweepItem[]) => {
      const { data, error } = await server().rpc('storage_sweep_confirm', { items });
      if (error) throw new Error('Storage sweep unavailable');
      return readStorageSweepConfirm(data);
    },
  };
}
