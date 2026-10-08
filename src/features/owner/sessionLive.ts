import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { getSupabase } from '@/lib/supabase';
import { attemptStore } from '../rental/attemptStore';
import { createSessionJournal } from './sessionAttempt';
import type { OwnerHttpTransport } from './venueClient';
const journals = new Map<string, ReturnType<typeof createSessionJournal>>();
export function sessionServices(actor: string): { transport: OwnerHttpTransport; journal: ReturnType<typeof createSessionJournal> } {
  const client = getSupabase(); const url = process.env.EXPO_PUBLIC_SUPABASE_URL!.trim();
  const namespace = `pickly.${new URL(url).host.replace(/[^a-z0-9.-]/gi, '_')}.${actor}`;
  let journal = journals.get(namespace);
  if (!journal) { journal = createSessionJournal(attemptStore, namespace); journals.set(namespace, journal); }
  return { journal, transport: { endpoint: `${url}/functions/v1/owner-sessions`, apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(),
    accessToken: async () => {
      const { data, error } = await client.auth.getSession();
      return !error && data.session?.user.id === actor ? data.session.access_token : null;
    }, fetch: fetchWithDeadline } };
}
