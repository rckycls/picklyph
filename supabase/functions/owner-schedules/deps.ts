import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { ScheduleSave } from '../../../packages/domain/src/schedule.ts';
import type { AllocationBlock } from '../../../packages/domain/src/allocation.ts';
import type { CourtHoursSave } from '../../../packages/domain/src/calendar.ts';
import { AllocationRejected, createAllocationCommands } from '../_shared/allocations.ts';
import { ScheduleRejected } from './handler.ts';

function rejected(error: { code?: string; hint?: string | null } | null): never {
  if (error?.hint && ['invalid_input','not_owner','venue_unavailable','court_unavailable','version_conflict','hours_conflict'].includes(error.hint)) throw new ScheduleRejected(error.hint);
  if (error?.code === '42501') throw new ScheduleRejected('not_owner');
  throw new Error('Schedule command unavailable');
}
/** T21 inventory commands keep their own mapping; the handler sees one rejection type. */
async function relay<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof AllocationRejected) throw new ScheduleRejected(error.reason);
    throw error;
  }
}
export function createSupabaseScheduleDeps(verifier: () => SupabaseClient<Database>, server: () => SupabaseClient<Database>) {
  const allocations = createAllocationCommands(server);
  return {
    verifyUser: async (token: string): Promise<string | null> => {
      const { data, error } = await verifier().auth.getUser(token);
      if (error) {
        if ([400,401,403].includes(error.status ?? 0)) return null;
        throw new Error('Auth unavailable');
      }
      return data.user?.id ?? null;
    },
    read: async (actor: string, venue: string, startDate: string, days: number) => {
      const { data, error } = await server().rpc('venue_schedule_read', { actor_user_id: actor, target_venue_id: venue, start_date: startDate, days });
      if (error || !data) return rejected(error);
      return data;
    },
    save: async (actor: string, command: ScheduleSave) => {
      const { data, error } = await server().rpc('venue_schedule_save', { actor_user_id: actor, target_venue_id: command.venue_id,
        expected_revision: command.expected_revision, schedule_input: command.schedule });
      if (error || !data) return rejected(error);
      return data;
    },
    calendar: async (actor: string, venue: string, startDate: string, days: number) => {
      const { data, error } = await server().rpc('owner_calendar_read', { actor_user_id: actor, target_venue_id: venue, start_date: startDate, days });
      if (error || !data) return rejected(error);
      return data;
    },
    saveCourtHours: async (actor: string, command: CourtHoursSave) => {
      const { data, error } = await server().rpc('court_hours_save', { actor_user_id: actor, target_court_id: command.court_id,
        expected_revision: command.expected_revision, hours_input: command.hours });
      if (error || !data) return rejected(error);
      return data;
    },
    block: (actor: string, command: AllocationBlock) => relay(() => allocations.block(actor, command)),
    release: (actor: string, allocationId: string) => relay(() => allocations.release(actor, allocationId)),
  };
}
