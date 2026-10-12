import 'server-only';
import { BULK_PUBLICATION_STATUS, DirectoryInputError, readDirectoryBulk, readDirectorySave, readDirectoryPublication, readDirectoryImport,
  type DirectoryBulkOutcome } from '@picklyph/domain';
import { bulkOutcome } from './directory-bulk';
import { createAdminClient } from './supabase';
import { createDirectoryServiceClient } from './directory-server';
import { readConsoleAccess } from './access';
import { readAdminConfig } from './config';
import { RequestError, readJsonBody, requireSameOrigin } from './http';
import { jsonResponse } from './auth-handler';

export async function handleDirectoryPost(request: Request, operation: 'save' | 'publish' | 'import') {
  try {
    requireSameOrigin(request, readAdminConfig(process.env).origin);
    const access = await readConsoleAccess(await createAdminClient(true), 'admin');
    if (access.status !== 'allowed') return jsonResponse({ error: 'Administrator access required.' }, access.status === 'guest' ? 401 : access.status === 'denied' ? 403 : 503);
    const input = await readJsonBody(request, operation === 'import' ? 256 * 1024 : 32 * 1024);
    // Parse first, then create the infrastructure client. Actor is always the verified user.
    const result = await (async () => {
      if (operation === 'save') {
        const value = readDirectorySave(input);
        return createDirectoryServiceClient().rpc('directory_admin_save', { actor_user_id: access.actorId,
          target_venue_id: value.id, expected_updated_at: value.expected_updated_at, venue_input: value.venue, court_inputs: value.courts });
      }
      if (operation === 'publish') {
        const value = readDirectoryPublication(input);
        return createDirectoryServiceClient().rpc('directory_admin_publish', { actor_user_id: access.actorId,
          target_venue_id: value.id, expected_updated_at: value.expected_updated_at, new_status: value.publication_status });
      }
      const listings = readDirectoryImport(input);
      return createDirectoryServiceClient().rpc('directory_admin_import', { actor_user_id: access.actorId, listings });
    })();
    if (result.error) {
      const code = result.error.code;
      if (result.error.hint === 'court_allocated') throw new RequestError(409, 'A court with upcoming blocks or bookings can’t be made inactive. Release them first.');
      if (code === '42501') throw new RequestError(403, 'Administrator access required.');
      if (code === '40001') throw new RequestError(409, 'This listing changed. Reload it before saving again.');
      if (code === '23505') throw new RequestError(409, operation === 'import' ? 'An import reference has different data. Edit its existing listing instead.' : 'A court name already exists. Use a unique name.');
      if (code === 'P0002') throw new RequestError(404, 'Listing not found.');
      if (['22023', '22P02', '23514'].includes(code)) throw new RequestError(400, 'Check the listing fields. Published venues need an active court.');
      throw new Error('Unavailable');
    }
    if (!result.data) throw new Error('Unavailable');
    return jsonResponse({ data: result.data });
  } catch (error) {
    if (error instanceof DirectoryInputError) return jsonResponse({ error: error.message }, 400);
    if (error instanceof RequestError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse({ error: 'Directory tools are unavailable. Retry or contact the operator.' }, 503);
  }
}

/**
 * Bulk publish, move to draft, suspend or delete (2026-10-13). Each listing runs through the same audited,
 * version-checked command as a single change, one after another, so one listing that can't change (no active
 * court, history, a newer version) never blocks the others. The answer lists every outcome in request order.
 */
export async function handleDirectoryBulk(request: Request) {
  try {
    requireSameOrigin(request, readAdminConfig(process.env).origin);
    const access = await readConsoleAccess(await createAdminClient(true), 'admin');
    if (access.status !== 'allowed') return jsonResponse({ error: 'Administrator access required.' }, access.status === 'guest' ? 401 : access.status === 'denied' ? 403 : 503);
    const bulk = readDirectoryBulk(await readJsonBody(request, 32 * 1024));
    const service = createDirectoryServiceClient();
    const outcomes: DirectoryBulkOutcome[] = [];
    for (const item of bulk.items) {
      const { error } = bulk.action === 'delete'
        ? await service.rpc('directory_admin_delete', { actor_user_id: access.actorId, target_venue_id: item.id, expected_updated_at: item.expected_updated_at })
        : await service.rpc('directory_admin_publish', { actor_user_id: access.actorId, target_venue_id: item.id,
          expected_updated_at: item.expected_updated_at, new_status: BULK_PUBLICATION_STATUS[bulk.action] });
      outcomes.push(bulkOutcome(bulk.action, item.id, error));
    }
    return jsonResponse({ data: { action: bulk.action, outcomes } });
  } catch (error) {
    if (error instanceof DirectoryInputError) return jsonResponse({ error: error.message }, 400);
    if (error instanceof RequestError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse({ error: 'Directory tools are unavailable. Retry or contact the operator.' }, 503);
  }
}
