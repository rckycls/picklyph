import Link from 'next/link';
import { notFound } from 'next/navigation';
import { REPORT_REASON_LABELS, REVOCATION_REASON_LABELS, formatManilaDateTime, isUuid, type ModerationEvent, type ReportReason, type RevocationReason } from '@picklyph/domain';
import { readReviewAccess } from '@/lib/ownership-server';
import { readModerationVenue } from '@/lib/moderation-server';
import { MODERATION_ACTION_LABELS } from '@/lib/moderation';
import { ReinstateForm, ReportDecisionForm, RevokeOwnerForm } from '@/components/moderation';
import { AccessProblem, Unavailable } from '@/components/console-state';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { toDisplayInstant } from '@/lib/ownership';

const when = (value: string) => formatManilaDateTime(toDisplayInstant(value));
const mapLink = (latitude: number, longitude: number) => `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
const reportStatus = { open: 'Open', dismissed: 'Dismissed', resolved: 'Resolved' } as const;
const listingLabel = (publication: string, claim: string) =>
  `${publication === 'approved' ? 'Published' : publication === 'suspended' ? 'Suspended' : 'Draft'} · ${claim === 'verified' ? 'Verified owner' : claim === 'pending' ? 'Claim pending' : 'Unclaimed'}`;
const reasonLabel = (event: ModerationEvent) => !event.reason ? '' : ` · ${event.action === 'owner.revoke'
  ? REVOCATION_REASON_LABELS[event.reason as RevocationReason] : REPORT_REASON_LABELS[event.reason as ReportReason]}`;

export default async function ReportedListingPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await readReviewAccess();
  if (access.status !== 'allowed') return <AccessProblem area="reports" status={access.status} />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const item = await (async () => { try { return await readModerationVenue(access.actorId, id.toLowerCase()); } catch { return undefined; } })();
  if (item === undefined) return <Unavailable area="reports" />;
  if (item === null) notFound();
  const { venue } = item;
  const admin = access.roles.includes('admin');
  const own = item.owners.some(owner => owner.user_id === access.actorId);
  const open = item.reports.filter(report => report.status === 'open');
  const published = venue.publication_status === 'approved';

  return <>
    <PageHeader crumbs={[{ href: '/console/reports', label: 'Listing reports' }]} title={venue.name}
      meta={<><span className={`badge publication-${venue.publication_status}`}>{published ? 'Published' : venue.publication_status === 'suspended' ? 'Suspended' : 'Draft'}</span> <span className={item.open_reports ? 'badge signal' : 'badge neutral'}>{item.open_reports === 1 ? '1 open report' : `${item.open_reports} open reports`}</span> {venue.city}, {venue.province}</>} />
    <div className="review-layout"><div className="review-column">
      <Panel title="Listing"><dl className="fact-list">
        <dt>Listing</dt><dd>{admin ? <Link href={`/console/directory/${venue.id}`}>{venue.name}</Link> : venue.name}</dd>
        <dt>Address</dt><dd>{venue.address_line}, {venue.city}, {venue.province}</dd>
        <dt>Pin</dt><dd><a href={mapLink(venue.latitude, venue.longitude)} target="_blank" rel="noopener noreferrer">{venue.latitude}, {venue.longitude}</a></dd>
        <dt>Status</dt><dd>{listingLabel(venue.publication_status, venue.claim_status)}</dd>
        <dt>Active courts</dt><dd>{venue.active_court_count}</dd>
        <dt>Owners</dt><dd>{item.owners.length ? item.owners.map(owner => `${owner.display_name ?? 'No display name'} (since ${when(owner.verified_at)})`).join(', ') : 'None'}</dd></dl>
        {item.suspension && <p className="notice">Suspended by moderation on {when(item.suspension.suspended_at)}: {REPORT_REASON_LABELS[item.suspension.reason]}. It is off Discover and takes no new bookings.</p>}
        {!item.suspension && venue.publication_status === 'suspended' && <p className="notice">Suspended from the directory, or a retired owner draft. Only an administrator can publish it, from the directory.</p>}</Panel>
      <Panel title={`Reports (${item.reports.length})`}>
        {item.reports.length ? <ul className="nearby-list">{item.reports.map(report => <li key={report.id}><div><strong>{REPORT_REASON_LABELS[report.reason]}</strong> <span className={report.status === 'open' ? 'badge signal' : 'badge neutral'}>{reportStatus[report.status]}</span><span className="muted"> · {when(report.created_at)}</span></div>
          {report.details && <p className="submitter-note">{report.details}</p>}
          <span className="muted small-note">{report.reporter ? <>From {report.reporter.display_name ?? 'a player without a display name'} · <code>{report.reporter.id}</code></> : 'Reporter account deleted'}{report.reviewed_at ? ` · Decided ${when(report.reviewed_at)}` : ''}</span></li>)}</ul> : <p className="muted">No reports.</p>}
        {item.reports.length === 100 && <p className="field-hint">Showing the latest 100 reports.</p>}</Panel>
      <Panel title="Moderation history">
        {item.history.length ? <ul className="nearby-list">{item.history.map(event => <li key={event.id}><div><strong>{MODERATION_ACTION_LABELS[event.action]}</strong><span className="muted">{reasonLabel(event)} · {when(event.occurred_at)}</span></div><span className="muted small-note">By <code>{event.actor_user_id}</code></span></li>)}</ul> : <p className="muted">No moderation yet.</p>}</Panel>
    </div><div className="review-column">
      {own ? <Panel title="Decision"><p>You manage this listing, so another reviewer must decide its reports.</p></Panel> : <>
        {(open.length > 0 || published) && <ReportDecisionForm key={open.map(report => report.id).join()} venueId={venue.id} published={published}
          reports={open.map(report => ({ id: report.id, label: `${REPORT_REASON_LABELS[report.reason]} · ${when(report.created_at)}` }))} />}
        {item.suspension && <ReinstateForm venueId={venue.id} />}
        {item.owners.length > 0 && <RevokeOwnerForm venueId={venue.id} owners={item.owners.map(owner => ({ user_id: owner.user_id, label: `${owner.display_name ?? 'No display name'} · ${owner.user_id}` }))} />}
      </>}
    </div></div>
  </>;
}
