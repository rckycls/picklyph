import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { recoveryNamespace } from '@/lib/recoveryKeys';
import { getSupabase } from '@/lib/supabase';
import { attemptStore } from '../rental/attemptStore';
import { createEntryJournal, type DeskTransports } from './deskClient';
import type { OwnerHttpTransport } from './venueClient';

const journals = new Map<string, ReturnType<typeof createEntryJournal>>();
/** Device-only recovery is namespaced by backend AND verified account; account deletion clears `.owner-entry-attempt` (`@/lib/recoveryKeys`). */
export function deskServices(actor: string): { transports: DeskTransports; journal: ReturnType<typeof createEntryJournal> } {
  const client = getSupabase(); const url = process.env.EXPO_PUBLIC_SUPABASE_URL!.trim();
  const namespace = recoveryNamespace(url, actor);
  let journal = journals.get(namespace);
  if (!journal) { journal = createEntryJournal(attemptStore, namespace); journals.set(namespace, journal); }
  const transport = (name: string): OwnerHttpTransport => ({ endpoint: `${url}/functions/v1/${name}`, apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(),
    accessToken: async () => {
      const { data, error } = await client.auth.getSession();
      return !error && data.session?.user.id === actor ? data.session.access_token : null;
    }, fetch: fetchWithDeadline });
  return { journal, transports: { rental: transport('rental-bookings'), group: transport('session-bookings') } };
}
