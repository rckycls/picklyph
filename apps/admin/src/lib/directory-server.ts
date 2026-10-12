import 'server-only';
import { createClient } from '@supabase/supabase-js';
import type { Database, VenuePublicationStatus } from '@picklyph/domain';
import { readDirectoryConfig } from './config';
import { createAdminClient } from './supabase';
import { readConsoleAccess, type ConsoleAccess } from './access';

export async function readDirectoryAccess(): Promise<ConsoleAccess> {
  try { return await readConsoleAccess(await createAdminClient(), 'admin'); }
  catch { return { status: 'unavailable' }; }
}

/** Separate from cookie auth: no incoming Authorization header or user session. */
export function createDirectoryServiceClient() {
  const config = readDirectoryConfig(process.env);
  return createClient<Database>(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, init) => fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15000) }) },
  });
}

/** `status` filters the list; without it the call also works on a database that predates the filter. */
export async function readDirectoryPage(actorId: string, target: string | null = null, after: string | null = null, status: VenuePublicationStatus | null = null) {
  const { data, error } = await createDirectoryServiceClient().rpc('directory_admin_read', {
    actor_user_id: actorId, target_venue_id: target, after_id: after, ...(status ? { publication_filter: status } : {}),
  });
  if (error || !data) throw new Error('Directory is unavailable.');
  return data;
}
