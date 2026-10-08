import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { getSupabase } from '@/lib/supabase';
import { attemptStore } from '../rental/attemptStore';
import { createGroupJournal } from './attempt';
import type { GroupTransport } from './client';

const journals = new Map<string, ReturnType<typeof createGroupJournal>>();
/** Device-only recovery is namespaced by backend AND verified account; T47 must clear `.group-attempt` on account deletion. */
export function openPlayServices(actor: string): { transport: GroupTransport; journal: ReturnType<typeof createGroupJournal> } {
  const client = getSupabase(); const url = process.env.EXPO_PUBLIC_SUPABASE_URL!.trim();
  const namespace = `pickly.${new URL(url).host.replace(/[^a-z0-9.-]/gi, '_')}.${actor}`;
  let journal = journals.get(namespace);
  if (!journal) { journal = createGroupJournal(attemptStore, namespace); journals.set(namespace, journal); }
  return { journal, transport: { endpoint: `${url}/functions/v1/session-bookings`, apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(),
    accessToken: async () => {
      const { data, error } = await client.auth.getSession();
      return !error && data.session?.user.id === actor ? data.session.access_token : null;
    }, fetch: fetchWithDeadline } };
}
