import 'server-only';
import { readOpsAdminView } from '@picklyph/domain/src/ops.ts';
import { createDirectoryServiceClient } from './directory-server';

/** The System health view (T51c): the database rechecks the admin role and evaluates the checks live. */
export async function readHealthView(actorId: string) {
  const { data, error } = await createDirectoryServiceClient().rpc('ops_admin_read', { actor_user_id: actorId });
  if (error || !data) throw new Error('System health is unavailable.');
  return readOpsAdminView(data);
}
