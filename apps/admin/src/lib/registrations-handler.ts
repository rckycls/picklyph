import 'server-only';
import { MAX_REGISTRATION_BATCH_BYTES, PrelaunchInputError, readRegistrationErase, readRegistrationSend, type RegistrationAction,
  type RegistrationBatchResult, type ReviewCursor, type RegistrationStatus } from '@picklyph/domain';
import { createEmailSender } from '@picklyph/domain/src/prelaunchEmail.ts';
import { createAdminClient } from './supabase';
import { createDirectoryServiceClient } from './directory-server';
import { readConsoleAccess } from './access';
import { readAdminConfig } from './config';
import { RequestError, readJsonBody, requireSameOrigin } from './http';
import { jsonResponse } from './auth-handler';
import { eraseRegistrations, readRegistrationSettings, sendNewCodes, type RegistrationSettings } from './registrations';

/** Newest first, 50 a page, with contact details: the database rechecks the admin role. */
export async function readRegistrationsPage(actorId: string, status: RegistrationStatus | null, email: string | null, after: ReviewCursor | null) {
  const { data, error } = await createDirectoryServiceClient().rpc('prelaunch_admin_read', { actor_user_id: actorId, status_filter: status,
    email_filter: email, after_created_at: after?.created_at ?? null, after_id: after?.id ?? null });
  if (error || !data) throw new Error('Registrations are unavailable.');
  return data;
}

/**
 * `POST /api/console/registrations/send|erase` (T54b). Administrators only; the actor is the verified session and
 * every command rechecks the role in its own transaction. Up to 25 registrations run one after another, and the
 * answer lists every outcome in request order. Codes and contact details are never logged.
 */
export async function handleRegistrationBatch(request: Request, action: RegistrationAction) {
  try {
    requireSameOrigin(request, readAdminConfig(process.env).origin);
    const access = await readConsoleAccess(await createAdminClient(true), 'admin');
    if (access.status !== 'allowed') return jsonResponse({ error: 'Administrator access required.' }, access.status === 'guest' ? 401 : access.status === 'denied' ? 403 : 503);
    const input = await readJsonBody(request, MAX_REGISTRATION_BATCH_BYTES);
    if (action === 'erase') {
      const ids = readRegistrationErase(input);
      const service = createDirectoryServiceClient();
      const outcomes = await eraseRegistrations(ids, (id) => service.rpc('prelaunch_admin_erase', { actor_user_id: access.actorId, registration_id: id }));
      return jsonResponse({ data: { action, outcomes } satisfies RegistrationBatchResult });
    }
    const items = readRegistrationSend(input);
    // Checked before anything rotates: without these a new code could never reach anyone.
    let settings: RegistrationSettings;
    try { settings = readRegistrationSettings(process.env); } catch {
      return jsonResponse({ error: 'Sending codes isn’t set up on this console. Ask the operator to add the email and code settings.' }, 503);
    }
    const service = createDirectoryServiceClient();
    const outcomes = await sendNewCodes(items, settings, {
      rotate: (id, expectedVersion, codeHash) => service.rpc('prelaunch_admin_rotate', { actor_user_id: access.actorId, registration_id: id,
        expected_version: expectedVersion, code_hash: codeHash }),
      emailSent: (id, version) => service.rpc('prelaunch_email_sent', { registration_id: id, sent_version: version }),
      sendEmail: createEmailSender(settings.email),
    });
    return jsonResponse({ data: { action, outcomes } satisfies RegistrationBatchResult });
  } catch (error) {
    if (error instanceof PrelaunchInputError) return jsonResponse({ error: error.message }, 400);
    if (error instanceof RequestError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse({ error: 'Registrations are unavailable. Retry or contact the operator.' }, 503);
  }
}
