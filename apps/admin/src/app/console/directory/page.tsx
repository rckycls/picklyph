import Link from 'next/link';
import { directoryUuid } from '@picklyph/domain';
import { readDirectoryPage, readDirectoryAccess } from '@/lib/directory-server';
import { DirectoryUnavailable } from '@/components/directory-shell';
import { DirectoryList } from '@/components/directory-list';

// Status tabs (2026-10-13). "All" calls the read without a filter, so it also works on an older database.
const FILTERS = [
  { key: 'all', label: 'All', status: null, empty: 'Your directory starts here.' },
  { key: 'draft', label: 'Drafts', status: 'draft', empty: 'No drafts.' },
  { key: 'published', label: 'Published', status: 'approved', empty: 'Nothing published yet.' },
  { key: 'suspended', label: 'Suspended', status: 'suspended', empty: 'No suspended listings.' },
] as const;
const pageHref = (filter: string, after?: string | null) => {
  const query = new URLSearchParams();
  if (filter !== 'all') query.set('status', filter);
  if (after) query.set('after', after);
  return query.size ? `/console/directory?${query}` : '/console/directory';
};

export default async function DirectoryPage({ searchParams }: { searchParams: Promise<{ after?: string; status?: string }> }) {
  // Layouts may persist in the router. Every data-bearing page verifies independently.
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <DirectoryUnavailable />;
  const { after, status } = await searchParams;
  const filter = FILTERS.find((item) => item.key === status) ?? FILTERS[0];
  const page = await (async () => {
    try { return await readDirectoryPage(access.actorId, null, after ? directoryUuid(after) : null, filter.status); }
    catch { return null; }
  })();
  if (!page) return <DirectoryUnavailable />;
  return <><div className="page-heading"><p className="eyebrow">COURT DIRECTORY</p><h1>Better places to play.</h1><p className="muted">Keep local venue information accurate. Drafts stay private until you publish.</p></div>
    <div className="directory-actions"><Link className="button primary" href="/console/directory/new">Add a venue</Link><Link className="button secondary" href="/console/directory/import">Import listings</Link></div>
    <nav className="directory-filters" aria-label="Filter listings by status">{FILTERS.map((item) => <Link key={item.key} href={pageHref(item.key)} aria-current={item.key === filter.key ? 'page' : undefined}>{item.label}</Link>)}</nav>
    <section className="workspace-panel">{page.items.length
      ? <DirectoryList key={`${filter.key}:${after ?? ''}`} items={page.items} />
      : <div className="empty-directory"><h2>{after ? 'No more venues.' : filter.empty}</h2><p>Add a venue or import details you have permission to use.</p></div>}</section>
    <div className="directory-actions">{after && <Link className="button secondary" href={pageHref(filter.key)}>Back to first page</Link>}{page.next_cursor && <Link className="button secondary" href={pageHref(filter.key, page.next_cursor)}>Next page</Link>}</div></>;
}
