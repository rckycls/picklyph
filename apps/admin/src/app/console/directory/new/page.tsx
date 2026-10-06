import { readDirectoryAccess } from '@/lib/directory-server';
import { DirectoryUnavailable } from '@/components/directory-shell';
import { DirectoryEditor } from '@/components/directory-editor';
export default async function NewVenuePage() {
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <DirectoryUnavailable />;
  return <DirectoryEditor initial={null} />;
}
