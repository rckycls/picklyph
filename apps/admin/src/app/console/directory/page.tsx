import Link from 'next/link';
import { directoryUuid, formatManilaDateTime } from '@picklyph/domain';
import { readDirectoryPage, readDirectoryAccess } from '@/lib/directory-server';
import { AccessProblem, Unavailable } from '@/components/console-state';
import { DirectoryList } from '@/components/directory-list';
import { Icon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { toDisplayInstant } from '@/lib/ownership';

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
// Formatted on the server so the browser hydrates the same text.
const stamp = (value: string) => { try { return formatManilaDateTime(toDisplayInstant(value)); } catch { return ''; } };

export default async function DirectoryPage({ searchParams }: { searchParams: Promise<{ after?: string; status?: string }> }) {
  // Layouts may persist in the router. Every data-bearing page verifies independently.
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <AccessProblem area="directory" status={access.status} />;
  const { after, status } = await searchParams;
  const filter = FILTERS.find((item) => item.key === status) ?? FILTERS[0];
  const page = await (async () => {
    try { return await readDirectoryPage(access.actorId, null, after ? directoryUuid(after) : null, filter.status); }
    catch { return null; }
  })();
  if (!page) return <Unavailable area="directory" />;
  return <>
    <PageHeader title="Court directory" meta="Keep local venue information accurate. Drafts stay private until you publish."
      actions={<><Link className="button secondary" href="/console/directory/import"><Icon name="upload" />Import listings</Link><Link className="button primary" href="/console/directory/new"><Icon name="plus" />Add a venue</Link></>} />
    <section className="panel" aria-label="Listings">
      <nav className="tabs" aria-label="Filter listings by status">{FILTERS.map((item) => <Link key={item.key} href={pageHref(item.key)} aria-current={item.key === filter.key ? 'page' : undefined}>{item.label}</Link>)}</nav>
      {page.items.length
        ? <DirectoryList key={`${filter.key}:${after ?? ''}`} items={page.items} updated={Object.fromEntries(page.items.map((venue) => [venue.id, stamp(venue.updated_at)]))} />
        : <div className="empty-state"><h2>{after ? 'No more venues.' : filter.empty}</h2><p>Add a venue or import details you have permission to use.</p></div>}
      {(after || page.next_cursor) && <div className="panel-foot">{after && <Link className="button secondary compact" href={pageHref(filter.key)}>Back to first page</Link>}{page.next_cursor && <Link className="button secondary compact" href={pageHref(filter.key, page.next_cursor)}>Next page</Link>}</div>}
    </section>
  </>;
}
