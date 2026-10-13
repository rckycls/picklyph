import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { CrashRecord } from '../../../packages/domain/src/crash.ts';
import { CRASH_OUTCOMES, CrashRejected, type CrashOutcome } from './handler.ts';

export function createSupabaseCrashDeps(server: () => SupabaseClient<Database>) {
  return {
    record: async (report: CrashRecord): Promise<CrashOutcome> => {
      const { data, error } = await server().rpc('crash_report_record', { report });
      if (error?.hint === 'invalid_input') throw new CrashRejected();
      const outcome = (data as { outcome?: unknown } | null)?.outcome;
      if (error || !(CRASH_OUTCOMES as readonly unknown[]).includes(outcome)) throw new Error('Crash reports unavailable');
      return outcome as CrashOutcome;
    },
  };
}
