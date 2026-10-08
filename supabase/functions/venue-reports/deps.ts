import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import type { VenueReportRequest } from '../../../packages/domain/src/moderation.ts';
import { REPORT_STATUS, ReportRejected } from './handler.ts';
export function createSupabaseReportDeps(verifier: () => SupabaseClient<Database>, server: () => SupabaseClient<Database>) {
  return {
    verifyUser: async (token: string): Promise<string | null> => {
      const { data, error } = await verifier().auth.getUser(token);
      if (error) {
        if ([400, 401, 403].includes(error.status ?? 0)) return null;
        throw new Error('Auth unavailable');
      }
      return data.user?.id ?? null;
    },
    submit: async (actor: string, report: VenueReportRequest) => {
      const { data, error } = await server().rpc('venue_report_submit', { actor_user_id: actor, report_input: report });
      if (error?.hint && REPORT_STATUS[error.hint]) throw new ReportRejected(error.hint);
      if (error || !data) throw new Error('Reports unavailable');
      return data;
    },
  };
}
