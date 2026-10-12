import Link from 'next/link';
import { formatManilaDateTime, formatReviewCursor, readReviewCursor, type OwnershipQueueItem } from '@picklyph/domain';
import { readOwnershipQueue, readReviewAccess } from '@/lib/ownership-server';
import { AccessProblem, Unavailable } from '@/components/console-state';
import { PageHeader } from '@/components/page-header';
import { toDisplayInstant } from '@/lib/ownership';

const signal = (item: OwnershipQueueItem) => item.kind === 'claim' ? 'Competing claim or owner' : 'Possible duplicate';
export default async function OwnershipQueuePage({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  // Layouts may persist in the router. Every data-bearing page verifies independently.
  const access = await readReviewAccess();
  if (access.status !== 'allowed') return <AccessProblem area="ownership" status={access.status} />;
  const { after } = await searchParams;
  const cursor = (() => { try { return readReviewCursor(after); } catch { return null; } })();
  const page = await (async () => { try { return await readOwnershipQueue(access.actorId, cursor); } catch { return null; } })();
  if (!page) return <Unavailable area="ownership" />;
  return <>
    <PageHeader title="Ownership review" meta={`${page.pending_total === 1 ? '1 request is' : `${page.pending_total} requests are`} waiting, oldest first. Check the proof photo and nearby listings before deciding.`} />
    <section className="panel" aria-label="Requests">
      {page.items.length ? <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Request</th><th scope="col">Type</th><th scope="col">Location</th><th scope="col">Submitted</th><th scope="col">Signals</th></tr></thead>
        <tbody>{page.items.map(item => <tr key={item.id}>
          <td><Link className="cell-link" href={`/console/ownership/${item.id}`}>{item.name}</Link></td>
          <td><span className={`badge kind-${item.kind}`}>{item.kind === 'claim' ? 'Ownership claim' : 'New venue'}</span></td>
          <td>{item.city}, {item.province}</td>
          <td className="nowrap">{formatManilaDateTime(toDisplayInstant(item.created_at))}</td>
          <td>{item.duplicate_signals > 0 ? <span className="badge signal">{signal(item)}</span> : <span className="muted">None</span>}</td>
        </tr>)}</tbody>
      </table></div> : <div className="empty-state"><h2>{cursor ? 'No more requests.' : 'All caught up.'}</h2><p>New ownership claims and missing-venue submissions appear here.</p></div>}
      {(cursor || page.next_cursor) && <div className="panel-foot">{cursor && <Link className="button secondary compact" href="/console/ownership">Back to first page</Link>}{page.next_cursor && <Link className="button secondary compact" href={`/console/ownership?after=${encodeURIComponent(formatReviewCursor(page.next_cursor))}`}>Next page</Link>}</div>}
    </section>
  </>;
}
