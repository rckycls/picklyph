import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/domain/src/database.ts';
import { readOpsRun, type OpsAlert, type OpsCheck } from '../../../packages/domain/src/ops.ts';

export function createSupabaseOpsDeps(server: () => SupabaseClient<Database>) {
  return {
    run: async (external: OpsCheck[]) => {
      const { data, error } = await server().rpc('ops_monitor_run', { external_checks: external });
      if (error) throw new Error('Monitor unavailable');
      return readOpsRun(data);
    },
    confirm: async (alerts: OpsAlert[]) => {
      const { data, error } = await server().rpc('ops_alerts_confirm', { alerts: alerts.map(({ check, status }) => ({ check, status })) });
      if (error || !data || !Number.isSafeInteger(data.confirmed)) throw new Error('Monitor unavailable');
      return data.confirmed;
    },
  };
}

/** Discord channel webhook: plain content, no mentions, no redirects. Never throws. */
export function createDiscordPoster(fetcher: typeof fetch) {
  return async (url: string, content: string): Promise<boolean> => {
    try {
      const response = await fetcher(`${url}?wait=true`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, username: 'PicklyPH monitor', allowed_mentions: { parse: [] } }),
      });
      await response.body?.cancel().catch(() => {});
      return response.ok;
    } catch { return false; }
  };
}

/** Heartbeat ping for an outside dead-man's switch. Never throws. */
export function createHeartbeat(fetcher: typeof fetch) {
  return async (url: string): Promise<void> => {
    try {
      const response = await fetcher(url, { method: 'GET', redirect: 'error' });
      await response.body?.cancel().catch(() => {});
    } catch { /* The outside service alerts when pings stop. */ }
  };
}
