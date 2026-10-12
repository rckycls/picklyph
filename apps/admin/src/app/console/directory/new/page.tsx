import { readDirectoryAccess } from '@/lib/directory-server';
import { AccessProblem } from '@/components/console-state';
import { DirectoryEditor } from '@/components/directory-editor';
export default async function NewVenuePage() {
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <AccessProblem area="directory" status={access.status} />;
  return <DirectoryEditor initial={null} />;
}
