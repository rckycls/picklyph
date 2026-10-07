import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { AllocationBlock, AllocationRange, AllocationRejection, AllocationResult } from '../../../packages/domain/src/allocation.ts';

/** HTTP status for each definitive refusal. Anything else is a retryable 503. */
export const ALLOCATION_STATUS: Record<AllocationRejection, number> = {
  invalid_input: 400, not_owner: 403, managed_allocation: 403, venue_unavailable: 404, court_unavailable: 404,
  allocation_not_found: 404, outside_hours: 409, allocation_conflict: 409, request_reused: 409, allocation_ended: 409,
};
export class AllocationRejected extends Error {
  constructor(readonly reason: AllocationRejection) { super(reason); }
}
function rejected(error: { code?: string; hint?: string | null } | null): never {
  if (error?.hint && Object.hasOwn(ALLOCATION_STATUS, error.hint)) throw new AllocationRejected(error.hint as AllocationRejection);
  if (error?.code === '42501') throw new AllocationRejected('not_owner');
  throw new Error('Allocation command unavailable');
}

/**
 * Server-only owner/admin inventory commands over the stateless service client.
 * `actor` MUST come from independently verified Auth, never the request body.
 * After an uncertain reply, retry `block` with the same request_id: it returns the
 * original allocation (in its current state) instead of creating another.
 */
export function createAllocationCommands(server: () => SupabaseClient<Database>) {
  return {
    block: async (actor: string, command: AllocationBlock): Promise<AllocationResult> => {
      const { data, error } = await server().rpc('court_allocation_block', { actor_user_id: actor, target_court_id: command.court_id,
        block_request_id: command.request_id, block_starts_at: command.starts_at, block_ends_at: command.ends_at });
      if (error || !data) return rejected(error);
      return data;
    },
    release: async (actor: string, allocationId: string): Promise<AllocationResult> => {
      const { data, error } = await server().rpc('court_allocation_release', { actor_user_id: actor, target_allocation_id: allocationId });
      if (error || !data) return rejected(error);
      return data;
    },
    read: async (actor: string, venueId: string, rangeStart: string, rangeEnd: string): Promise<AllocationRange> => {
      const { data, error } = await server().rpc('court_allocation_read', { actor_user_id: actor, target_venue_id: venueId,
        range_start: rangeStart, range_end: rangeEnd });
      if (error || !data) return rejected(error);
      return data;
    },
  };
}
