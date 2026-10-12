import { notFound } from 'next/navigation';
import { directoryUuid } from '@picklyph/domain';
import { readDirectoryPage, readDirectoryAccess } from '@/lib/directory-server';
import { DirectoryEditor } from '@/components/directory-editor';
import { AccessProblem, Unavailable } from '@/components/console-state';
export default async function EditVenuePage({ params }: { params: Promise<{ id: string }> }) {
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <AccessProblem area="directory" status={access.status} />;
  const page = await (async () => {
    try { const { id } = await params; return await readDirectoryPage(access.actorId, directoryUuid(id)); }
    catch { return null; }
  })();
  if (!page) return <Unavailable area="directory" />;
  const listing = page.items[0];
  if (!listing) notFound();
  return <DirectoryEditor key={`${listing.id}:${listing.updated_at}`} initial={listing} />;
}
