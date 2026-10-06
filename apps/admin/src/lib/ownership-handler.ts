import 'server-only';
import { MAX_EVIDENCE_BYTES, ReviewInputError, isUuid, readOwnershipDecision, sniffEvidence } from '@picklyph/domain';
import { createAdminClient } from './supabase';
import { createDirectoryServiceClient } from './directory-server';
import { readConsoleAccess } from './access';
import { readAdminConfig } from './config';
import { RequestError, readJsonBody, requireSameOrigin } from './http';
import { jsonResponse } from './auth-handler';
import { evidenceHeaders, isSameOriginFetch, reviewRejection } from './ownership';

const accessError = (status: 'guest' | 'denied' | 'unavailable') =>
  jsonResponse({ error: 'Ownership reviewer access required.' }, status === 'guest' ? 401 : status === 'denied' ? 403 : 503);

export async function handleOwnershipDecision(request: Request) {
  try {
    requireSameOrigin(request, readAdminConfig(process.env).origin);
    const access = await readConsoleAccess(await createAdminClient(true), 'moderator');
    if (access.status !== 'allowed') return accessError(access.status);
    const decision = readOwnershipDecision(await readJsonBody(request, 2048));
    // The actor is always the verified user; the database re-checks the role inside its transaction.
    const { data, error } = await createDirectoryServiceClient().rpc('ownership_review_decide', {
      actor_user_id: access.actorId, subject_id: decision.subject_id, decision: decision.decision,
      target_venue_id: decision.target_venue_id, rejection_reason: decision.rejection_reason,
    });
    if (error) {
      const rejection = reviewRejection(error);
      if (rejection) throw new RequestError(rejection.status, rejection.message);
      throw new Error('Unavailable');
    }
    if (!data) throw new Error('Unavailable');
    return jsonResponse({ data });
  } catch (error) {
    if (error instanceof ReviewInputError) return jsonResponse({ error: 'Check the decision and try again.' }, 400);
    if (error instanceof RequestError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse({ error: 'Ownership review is unavailable. Retry or contact the operator.' }, 503);
  }
}

/** Streams private evidence to a verified reviewer. No signed URL ever reaches the browser. */
export async function handleEvidence(request: Request, subjectId: string) {
  try {
    if (!isSameOriginFetch(request)) return jsonResponse({ error: 'Request origin is not allowed.' }, 403);
    if (!isUuid(subjectId)) return jsonResponse({ error: 'Not found.' }, 404);
    const access = await readConsoleAccess(await createAdminClient(), 'moderator');
    if (access.status !== 'allowed') return accessError(access.status);
    const service = createDirectoryServiceClient();
    const located = await service.rpc('ownership_review_evidence', { actor_user_id: access.actorId, subject_id: subjectId.toLowerCase() });
    if (located.error) {
      const rejection = reviewRejection(located.error);
      return rejection ? jsonResponse({ error: rejection.message }, rejection.status) : jsonResponse({ error: 'Evidence is unavailable.' }, 503);
    }
    if (!located.data) return jsonResponse({ error: 'Evidence is unavailable.' }, 503);
    const file = await service.storage.from('owner-evidence').download(located.data);
    if (file.error || !file.data) return jsonResponse({ error: 'Evidence is unavailable.' }, 503);
    if (file.data.size > MAX_EVIDENCE_BYTES) return jsonResponse({ error: 'Evidence is unavailable.' }, 502);
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    const type = sniffEvidence(bytes);
    if (!type) return jsonResponse({ error: 'Evidence is unavailable.' }, 502);
    return new Response(bytes, { status: 200, headers: evidenceHeaders(type) });
  } catch {
    return jsonResponse({ error: 'Evidence is unavailable.' }, 503);
  }
}
