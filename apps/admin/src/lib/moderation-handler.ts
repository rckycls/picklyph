import 'server-only';
import { ModerationInputError, readModerationDecision, readOwnershipRevocation } from '@picklyph/domain';
import { createAdminClient } from './supabase';
import { createDirectoryServiceClient } from './directory-server';
import { readConsoleAccess } from './access';
import { readAdminConfig } from './config';
import { RequestError, readJsonBody, requireSameOrigin } from './http';
import { jsonResponse } from './auth-handler';
import { moderationRejection } from './moderation';

type Call = (actorId: string, body: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string; hint?: string | null } | null }>;

async function moderate(request: Request, maxBytes: number, call: Call) {
  try {
    requireSameOrigin(request, readAdminConfig(process.env).origin);
    const access = await readConsoleAccess(await createAdminClient(true), 'moderator');
    if (access.status !== 'allowed') {
      return jsonResponse({ error: 'Moderator access required.' }, access.status === 'guest' ? 401 : access.status === 'denied' ? 403 : 503);
    }
    // The actor is always the verified user; the database re-checks the role inside its transaction.
    const { data, error } = await call(access.actorId, await readJsonBody(request, maxBytes));
    if (error) {
      const rejection = moderationRejection(error);
      if (rejection) throw new RequestError(rejection.status, rejection.message);
      throw new Error('Unavailable');
    }
    if (!data) throw new Error('Unavailable');
    return jsonResponse({ data });
  } catch (error) {
    if (error instanceof ModerationInputError) return jsonResponse({ error: 'Check the decision and try again.' }, 400);
    if (error instanceof RequestError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse({ error: 'Moderation is unavailable. Retry or contact the operator.' }, 503);
  }
}

/** POST /api/console/moderation/decide: dismiss/resolve reports, suspend or reinstate a listing. Up to 100 report IDs. */
export function handleModerationDecision(request: Request) {
  return moderate(request, 8192, (actorId, body) => {
    const decision = readModerationDecision(body);
    return createDirectoryServiceClient().rpc('moderation_decide', { actor_user_id: actorId, target_venue_id: decision.venue_id,
      decision: decision.decision, reason: decision.reason, report_ids: decision.report_ids });
  });
}

/** POST /api/console/moderation/revoke: remove one owner link (audited). */
export function handleOwnershipRevocation(request: Request) {
  return moderate(request, 1024, (actorId, body) => {
    const revocation = readOwnershipRevocation(body);
    return createDirectoryServiceClient().rpc('ownership_revoke', { actor_user_id: actorId, target_venue_id: revocation.venue_id,
      owner_user_id: revocation.owner_user_id, reason: revocation.reason });
  });
}
