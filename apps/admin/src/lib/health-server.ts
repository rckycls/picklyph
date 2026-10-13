import 'server-only';
import { readCrashAdminView } from '@picklyph/domain/src/crash.ts';
import { readOpsAdminView } from '@picklyph/domain/src/ops.ts';
import { createDirectoryServiceClient } from './directory-server';

/** The System health view (T51c): the database rechecks the admin role and evaluates the checks live. */
export async function readHealthView(actorId: string) {
  const { data, error } = await createDirectoryServiceClient().rpc('ops_admin_read', { actor_user_id: actorId });
  if (error || !data) throw new Error('System health is unavailable.');
  return readOpsAdminView(data);
}

/** The App crashes section (T51d): 7-day crash groups; the database rechecks the admin role. */
export async function readCrashView(actorId: string) {
  const { data, error } = await createDirectoryServiceClient().rpc('crash_admin_read', { actor_user_id: actorId });
  if (error || !data) throw new Error('Crash reports are unavailable.');
  return readCrashAdminView(data);
}
