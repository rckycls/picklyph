import Link from 'next/link';
import { REPORT_REASON_LABELS, formatManilaDateTime, formatReviewCursor, readReviewCursor } from '@picklyph/domain';
import { readReviewAccess } from '@/lib/ownership-server';
import { readModerationQueue } from '@/lib/moderation-server';
import { ModerationUnavailable } from '@/components/moderation';
import { toDisplayInstant } from '@/lib/ownership';

export default async function ReportsQueuePage({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  // Layouts may persist in the router. Every data-bearing page verifies independently.
  const access = await readReviewAccess();
  if (access.status !== 'allowed') return <ModerationUnavailable />;
  const { after } = await searchParams;
  const cursor = (() => { try { return readReviewCursor(after); } catch { return null; } })();
  const page = await (async () => { try { return await readModerationQueue(access.actorId, cursor); } catch { return null; } })();
  if (!page) return <ModerationUnavailable />;
  return <><div className="page-heading"><p className="eyebrow">LISTING REPORTS</p><h1>Help players find places they can count on.</h1><p className="muted">{page.open_total === 1 ? '1 listing has' : `${page.open_total} listings have`} open reports, oldest first. Check the listing before deciding.</p></div>
    <section className="workspace-panel">{page.items.length ? <div className="venue-list">{page.items.map(item => <Link className="venue-row" key={item.venue_id} href={`/console/reports/${item.venue_id}`}><div><h2>{item.name}</h2><p>{item.city}, {item.province} · First report {formatManilaDateTime(toDisplayInstant(item.oldest_report_at))}</p><p className="muted small-note">{item.reasons.map(reason => REPORT_REASON_LABELS[reason]).join(' · ')}</p></div><div className="review-badges">{item.publication_status !== 'approved' && <span className="badge publication-suspended">{item.publication_status === 'suspended' ? 'Suspended' : 'Draft'}</span>}<span className="badge signal">{item.open_reports === 1 ? '1 report' : `${item.open_reports} reports`}</span></div></Link>)}</div> : <div className="empty-directory"><h2>{cursor ? 'No more reports.' : 'All caught up.'}</h2><p>Reports players send about published listings appear here.</p></div>}</section>
    <div className="directory-actions">{cursor && <Link className="button secondary" href="/console/reports">Back to first page</Link>}{page.next_cursor && <Link className="button secondary" href={`/console/reports?after=${encodeURIComponent(formatReviewCursor(page.next_cursor))}`}>Next page</Link>}</div></>;
}
