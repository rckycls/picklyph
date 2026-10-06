import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, PrivilegedRole } from '@picklyph/domain';

export type ConsoleAccess =
  | { status: 'allowed'; actorId: string; email: string | null; roles: PrivilegedRole[] }
  | { status: 'guest' | 'denied' | 'unavailable' };

/** Request-specific verified identity, then fresh database roles. No session/JWT metadata trust. */
export async function readConsoleAccess(client: Pick<SupabaseClient<Database>, 'auth' | 'rpc'>, required?: PrivilegedRole): Promise<ConsoleAccess> {
  try {
    const { data, error } = await client.auth.getUser();
    if (error) return { status: !error.status || error.status >= 500 || error.status === 429 ? 'unavailable' : 'guest' };
    if (!data.user) return { status: 'guest' };
    const access = await client.rpc('my_account_access');
    if (access.error || access.data?.length !== 1 || !Array.isArray(access.data[0]?.privileged_roles)) return { status: 'unavailable' };
    const roles = access.data[0].privileged_roles.filter((role) => role === 'admin' || role === 'moderator');
    if (roles.length === 0 || (required && !roles.includes(required) && !roles.includes('admin'))) return { status: 'denied' };
    return { status: 'allowed', actorId: data.user.id, email: data.user.email ?? null, roles };
  } catch { return { status: 'unavailable' }; }
}
