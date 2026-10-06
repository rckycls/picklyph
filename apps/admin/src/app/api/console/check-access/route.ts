import { createAdminClient } from '@/lib/supabase';
import { readConsoleAccess } from '@/lib/access';
import { readAdminConfig } from '@/lib/config';
import { RequestError, requireSameOrigin } from '@/lib/http';
import { jsonResponse } from '@/lib/auth-handler';

/** Non-mutating guarded command foundation. Caller body never supplies actor/roles. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request, readAdminConfig(process.env).origin);
    const access = await readConsoleAccess(await createAdminClient(true));
    if (access.status !== 'allowed') return jsonResponse({ error: 'Console access is unavailable.' }, access.status === 'guest' ? 401 : access.status === 'denied' ? 403 : 503);
    return jsonResponse({ actorId: access.actorId, roles: access.roles });
  } catch (error) {
    return jsonResponse({ error: 'Console access is unavailable.' }, error instanceof RequestError ? error.status : 503);
  }
}
