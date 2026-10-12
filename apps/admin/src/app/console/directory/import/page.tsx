import { readDirectoryAccess } from '@/lib/directory-server';
import { AccessProblem } from '@/components/console-state';
import { DirectoryImport } from '@/components/directory-import';
export default async function ImportPage() {
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <AccessProblem area="directory" status={access.status} />;
  return <DirectoryImport />;
}
