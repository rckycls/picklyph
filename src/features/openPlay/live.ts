import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { recoveryNamespace } from '@/lib/recoveryKeys';
import { getSupabase } from '@/lib/supabase';
import { attemptStore } from '../rental/attemptStore';
import { createGroupJournal } from './attempt';
import type { GroupTransport } from './client';

const journals = new Map<string, ReturnType<typeof createGroupJournal>>();
/** Device-only recovery is namespaced by backend AND verified account; account deletion clears `.group-attempt` (`@/lib/recoveryKeys`). */
export function openPlayServices(actor: string): { transport: GroupTransport; journal: ReturnType<typeof createGroupJournal> } {
  const client = getSupabase(); const url = process.env.EXPO_PUBLIC_SUPABASE_URL!.trim();
  const namespace = recoveryNamespace(url, actor);
  let journal = journals.get(namespace);
  if (!journal) { journal = createGroupJournal(attemptStore, namespace); journals.set(namespace, journal); }
  return { journal, transport: { endpoint: `${url}/functions/v1/session-bookings`, apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(),
    accessToken: async () => {
      const { data, error } = await client.auth.getSession();
      return !error && data.session?.user.id === actor ? data.session.access_token : null;
    }, fetch: fetchWithDeadline } };
}
