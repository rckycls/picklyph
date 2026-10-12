import { redirect } from 'next/navigation';
import Link from 'next/link';
import { REPORT_REASON_LABELS, formatManilaDateTime } from '@picklyph/domain';
import { ConsoleState } from '@/components/console-state';
import { Icon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { SignoutButton } from '@/components/signout-button';
import { createAdminClient } from '@/lib/supabase';
import { readConsoleAccess, type ConsoleAccess } from '@/lib/access';
import { readOwnershipQueue } from '@/lib/ownership-server';
import { readModerationQueue } from '@/lib/moderation-server';
import { toDisplayInstant } from '@/lib/ownership';

const PREVIEW = 5;
const when = (value: string) => formatManilaDateTime(toDisplayInstant(value));
const settle = <T,>(read: Promise<T>) => read.catch(() => null);

function Stat({ href, label, value, hint }: { href: string; label: string; value: number | undefined; hint: string }) {
  return <Link className="stat-card" href={href}><span className="stat-label">{label}</span>
    <strong className="stat-value">{value ?? '—'}</strong><span className="stat-hint">{value === undefined ? 'Unavailable' : hint}</span></Link>;
}

export const dynamic = 'force-dynamic';
export default async function OverviewPage() {
  let access: ConsoleAccess;
  try { access = await readConsoleAccess(await createAdminClient()); } catch { access = { status: 'unavailable' }; }
  if (access.status === 'guest') redirect('/login');
  if (access.status !== 'allowed') return <ConsoleState label="Console access" title={access.status === 'denied' ? 'Access required.' : 'We couldn’t verify access.'}>
    <p>{access.status === 'denied' ? 'You’re signed in, but this account has no administrator or moderator assignment. Contact an administrator if you need console access.' : 'Sign-in or the permission service is unavailable. Try again shortly or contact the operator.'}</p>
    <div className="state-actions"><form action="/console" method="get"><button className="button primary" type="submit">Check again</button></form><SignoutButton /></div></ConsoleState>;

  const admin = access.roles.includes('admin');
  // Both queues are open to administrators and moderators; a failed read only blanks its own card.
  const [ownership, reports] = await Promise.all([settle(readOwnershipQueue(access.actorId, null)), settle(readModerationQueue(access.actorId, null))]);
  return <>
    <PageHeader title="Overview" meta="Requests and reports waiting for a decision, oldest first."
      actions={admin && <><Link className="button secondary" href="/console/directory/import"><Icon name="upload" />Import listings</Link><Link className="button primary" href="/console/directory/new"><Icon name="plus" />Add a venue</Link></>} />
    <div className="stat-grid">
      <Stat href="/console/ownership" label="Ownership requests" value={ownership?.pending_total} hint="Pending review" />
      <Stat href="/console/reports" label="Reported listings" value={reports?.open_total} hint="With open reports" />
      <div className="stat-card"><span className="stat-label">Your access</span><strong className="stat-value stat-text">{admin ? 'Administrator' : 'Moderator'}</strong><span className="stat-hint status-dot">Access verified</span></div>
    </div>
    <div className="overview-grid">
      <section className="panel" aria-labelledby="ownership-heading">
        <div className="panel-head"><h2 id="ownership-heading">Ownership requests</h2><Link className="panel-link" href="/console/ownership">View all<Icon name="arrow" /></Link></div>
        {!ownership ? <p className="panel-empty">The review queue is unavailable. Try again shortly.</p>
          : ownership.items.length === 0 ? <p className="panel-empty">All caught up. New claims and missing-venue submissions appear here.</p>
          : <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">Request</th><th scope="col">Type</th><th scope="col">Submitted</th></tr></thead>
            <tbody>{ownership.items.slice(0, PREVIEW).map((item) => <tr key={item.id}>
              <td><Link className="cell-link" href={`/console/ownership/${item.id}`}>{item.name}</Link><span className="cell-sub">{item.city}, {item.province}</span></td>
              <td><span className={`badge kind-${item.kind}`}>{item.kind === 'claim' ? 'Ownership claim' : 'New venue'}</span></td>
              <td className="nowrap">{when(item.created_at)}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="panel" aria-labelledby="reports-heading">
        <div className="panel-head"><h2 id="reports-heading">Listing reports</h2><Link className="panel-link" href="/console/reports">View all<Icon name="arrow" /></Link></div>
        {!reports ? <p className="panel-empty">Listing reports are unavailable. Try again shortly.</p>
          : reports.items.length === 0 ? <p className="panel-empty">All caught up. Reports players send about published listings appear here.</p>
          : <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">Listing</th><th scope="col" className="num">Reports</th><th scope="col">First report</th></tr></thead>
            <tbody>{reports.items.slice(0, PREVIEW).map((item) => <tr key={item.venue_id}>
              <td><Link className="cell-link" href={`/console/reports/${item.venue_id}`}>{item.name}</Link><span className="cell-sub">{item.reasons.map((reason) => REPORT_REASON_LABELS[reason]).join(' · ')}</span></td>
              <td className="num">{item.open_reports}</td>
              <td className="nowrap">{when(item.oldest_report_at)}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
    {admin && <section className="panel" aria-labelledby="directory-heading">
      <div className="panel-head"><h2 id="directory-heading">Court directory</h2><Link className="panel-link" href="/console/directory">Open directory<Icon name="arrow" /></Link></div>
      <ul className="shortcut-list">
        <li><Link href="/console/directory?status=draft"><strong>Drafts</strong><span>Private until you publish them.</span></Link></li>
        <li><Link href="/console/directory?status=published"><strong>Published</strong><span>Listings players can find on Discover.</span></Link></li>
        <li><Link href="/console/directory?status=suspended"><strong>Suspended</strong><span>Off Discover and taking no new bookings.</span></Link></li>
      </ul>
    </section>}
  </>;
}
