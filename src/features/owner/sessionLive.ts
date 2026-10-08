import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { getSupabase } from '@/lib/supabase';
import { attemptStore } from '../rental/attemptStore';
import { createSessionJournal } from './sessionAttempt';
import type { OwnerHttpTransport } from './venueClient';
import { createWalkInJournal } from './walkInClient';
type Journals = { session: ReturnType<typeof createSessionJournal>; walkIn: ReturnType<typeof createWalkInJournal> };
const journals = new Map<string, Journals>();
export function sessionServices(actor: string): { transport: OwnerHttpTransport; journal: Journals['session'];
  walkIns: { transport: OwnerHttpTransport; journal: Journals['walkIn'] } } {
  const client = getSupabase(); const url = process.env.EXPO_PUBLIC_SUPABASE_URL!.trim();
  const namespace = `pickly.${new URL(url).host.replace(/[^a-z0-9.-]/gi, '_')}.${actor}`;
  let saved = journals.get(namespace);
  if (!saved) { saved = { session: createSessionJournal(attemptStore, namespace), walkIn: createWalkInJournal(attemptStore, namespace) }; journals.set(namespace, saved); }
  const transport = (name: string): OwnerHttpTransport => ({ endpoint: `${url}/functions/v1/${name}`, apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(),
    accessToken: async () => {
      const { data, error } = await client.auth.getSession();
      return !error && data.session?.user.id === actor ? data.session.access_token : null;
    }, fetch: fetchWithDeadline });
  return { journal: saved.session, transport: transport('owner-sessions'), walkIns: { journal: saved.walkIn, transport: transport('session-bookings') } };
}
