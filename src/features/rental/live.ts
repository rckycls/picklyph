import { fetchWithDeadline } from '@/lib/fetchWithDeadline';
import { rentalRecoveryNamespace } from '@/lib/recoveryKeys';
import { getSupabase } from '@/lib/supabase';
import { createAttemptJournal } from './attempt';
import { attemptStore } from './attemptStore';
import type { RentalTransport } from './client';

const journals = new Map<string, ReturnType<typeof createAttemptJournal>>();
export function rentalServices(actor: string): { transport: RentalTransport; journal: ReturnType<typeof createAttemptJournal> } {
  const client = getSupabase();
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL!.trim();
  const namespace = rentalRecoveryNamespace(url, actor);
  let journal = journals.get(namespace);
  if (!journal) { journal = createAttemptJournal(attemptStore, namespace); journals.set(namespace, journal); }
  return { journal, transport: { endpoint: `${url}/functions/v1/rental-bookings`, apiKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(),
    accessToken: async () => {
      const { data, error } = await client.auth.getSession();
      return !error && data.session?.user.id === actor ? data.session.access_token : null;
    }, fetch: fetchWithDeadline } };
}
