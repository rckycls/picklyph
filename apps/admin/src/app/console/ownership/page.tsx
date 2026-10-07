import Link from 'next/link';
import { formatManilaDateTime, formatReviewCursor, readReviewCursor, type OwnershipQueueItem } from '@picklyph/domain';
import { readOwnershipQueue, readReviewAccess } from '@/lib/ownership-server';
import { ReviewUnavailable } from '@/components/ownership-review';
import { toDisplayInstant } from '@/lib/ownership';

const signal = (item: OwnershipQueueItem) => item.kind === 'claim' ? 'Competing claim or owner' : 'Possible duplicate';
export default async function OwnershipQueuePage({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  // Layouts may persist in the router. Every data-bearing page verifies independently.
  const access = await readReviewAccess();
  if (access.status !== 'allowed') return <ReviewUnavailable />;
  const { after } = await searchParams;
  const cursor = (() => { try { return readReviewCursor(after); } catch { return null; } })();
  const page = await (async () => { try { return await readOwnershipQueue(access.actorId, cursor); } catch { return null; } })();
  if (!page) return <ReviewUnavailable />;
  return <><div className="page-heading"><p className="eyebrow">OWNERSHIP REVIEW</p><h1>Connect courts with the people who run them.</h1><p className="muted">{page.pending_total === 1 ? '1 request is' : `${page.pending_total} requests are`} waiting, oldest first. Check the proof photo and nearby listings before deciding.</p></div>
    <section className="workspace-panel">{page.items.length ? <div className="venue-list">{page.items.map(item => <Link className="venue-row" key={item.id} href={`/console/ownership/${item.id}`}><div><h2>{item.name}</h2><p>{item.city}, {item.province} · Submitted {formatManilaDateTime(toDisplayInstant(item.created_at))}</p></div><div className="review-badges">{item.duplicate_signals > 0 && <span className="badge signal">{signal(item)}</span>}<span className={`badge kind-${item.kind}`}>{item.kind === 'claim' ? 'Ownership claim' : 'New venue'}</span></div></Link>)}</div> : <div className="empty-directory"><h2>{cursor ? 'No more requests.' : 'All caught up.'}</h2><p>New ownership claims and missing-venue submissions appear here.</p></div>}</section>
    <div className="directory-actions">{cursor && <Link className="button secondary" href="/console/ownership">Back to first page</Link>}{page.next_cursor && <Link className="button secondary" href={`/console/ownership?after=${encodeURIComponent(formatReviewCursor(page.next_cursor))}`}>Next page</Link>}</div></>;
}
