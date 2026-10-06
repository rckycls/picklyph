import Link from 'next/link';
import { directoryUuid } from '@picklyph/domain';
import { readDirectoryPage, readDirectoryAccess } from '@/lib/directory-server';
import { DirectoryUnavailable } from '@/components/directory-shell';

export default async function DirectoryPage({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  // Layouts may persist in the router. Every data-bearing page verifies independently.
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <DirectoryUnavailable />;
  const { after } = await searchParams;
  const page = await (async () => {
    try { return await readDirectoryPage(access.actorId, null, after ? directoryUuid(after) : null); }
    catch { return null; }
  })();
  if (!page) return <DirectoryUnavailable />;
    return <><div className="page-heading"><p className="eyebrow">COURT DIRECTORY</p><h1>Better places to play.</h1><p className="muted">Keep local venue information accurate. Drafts stay private until you publish.</p></div><div className="directory-actions"><Link className="button primary" href="/console/directory/new">Add a venue</Link><Link className="button secondary" href="/console/directory/import">Import listings</Link></div><section className="workspace-panel">{page.items.length ? <div className="venue-list">{page.items.map(venue => <Link className="venue-row" key={venue.id} href={`/console/directory/${venue.id}`}><div><h2>{venue.name}</h2><p>{venue.city}, {venue.province} · {venue.courts.length} courts</p></div><span className={`badge publication-${venue.publication_status}`}>{venue.publication_status === 'approved' ? 'Published' : venue.publication_status === 'suspended' ? 'Suspended' : 'Draft'}</span></Link>)}</div> : <div className="empty-directory"><h2>{after ? 'No more venues.' : 'Your directory starts here.'}</h2><p>Add a venue or import details you have permission to use.</p></div>}</section><div className="directory-actions">{after && <Link className="button secondary" href="/console/directory">Back to first page</Link>}{page.next_cursor && <Link className="button secondary" href={`/console/directory?after=${page.next_cursor}`}>Next page</Link>}</div></>;
}
