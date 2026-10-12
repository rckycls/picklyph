import Link from 'next/link';
import { REPORT_REASON_LABELS, formatManilaDateTime, formatReviewCursor, readReviewCursor } from '@picklyph/domain';
import { readReviewAccess } from '@/lib/ownership-server';
import { readModerationQueue } from '@/lib/moderation-server';
import { AccessProblem, Unavailable } from '@/components/console-state';
import { PageHeader } from '@/components/page-header';
import { toDisplayInstant } from '@/lib/ownership';

export default async function ReportsQueuePage({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  // Layouts may persist in the router. Every data-bearing page verifies independently.
  const access = await readReviewAccess();
  if (access.status !== 'allowed') return <AccessProblem area="reports" status={access.status} />;
  const { after } = await searchParams;
  const cursor = (() => { try { return readReviewCursor(after); } catch { return null; } })();
  const page = await (async () => { try { return await readModerationQueue(access.actorId, cursor); } catch { return null; } })();
  if (!page) return <Unavailable area="reports" />;
  return <>
    <PageHeader title="Listing reports" meta={`${page.open_total === 1 ? '1 listing has' : `${page.open_total} listings have`} open reports, oldest first. Check the listing before deciding.`} />
    <section className="panel" aria-label="Reported listings">
      {page.items.length ? <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Listing</th><th scope="col">Location</th><th scope="col">Reasons</th><th scope="col" className="num">Reports</th><th scope="col">First report</th><th scope="col">Status</th></tr></thead>
        <tbody>{page.items.map(item => <tr key={item.venue_id}>
          <td><Link className="cell-link" href={`/console/reports/${item.venue_id}`}>{item.name}</Link></td>
          <td>{item.city}, {item.province}</td>
          <td>{item.reasons.map(reason => REPORT_REASON_LABELS[reason]).join(' · ')}</td>
          <td className="num">{item.open_reports}</td>
          <td className="nowrap">{formatManilaDateTime(toDisplayInstant(item.oldest_report_at))}</td>
          <td><span className={`badge publication-${item.publication_status}`}>{item.publication_status === 'approved' ? 'Published' : item.publication_status === 'suspended' ? 'Suspended' : 'Draft'}</span></td>
        </tr>)}</tbody>
      </table></div> : <div className="empty-state"><h2>{cursor ? 'No more reports.' : 'All caught up.'}</h2><p>Reports players send about published listings appear here.</p></div>}
      {(cursor || page.next_cursor) && <div className="panel-foot">{cursor && <Link className="button secondary compact" href="/console/reports">Back to first page</Link>}{page.next_cursor && <Link className="button secondary compact" href={`/console/reports?after=${encodeURIComponent(formatReviewCursor(page.next_cursor))}`}>Next page</Link>}</div>}
    </section>
  </>;
}
