import { readDirectoryAccess } from '@/lib/directory-server';
import { DirectoryUnavailable } from '@/components/directory-shell';
import { DirectoryImport } from '@/components/directory-import';
export default async function ImportPage() {
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <DirectoryUnavailable />;
  return <DirectoryImport />;
}
