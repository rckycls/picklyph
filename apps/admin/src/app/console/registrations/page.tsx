import Link from 'next/link';
import { PrelaunchInputError, formatManilaDateTime, formatReviewCursor, readRegistrationEmailFilter, readRegistrationStatus, readReviewCursor,
  type AdminRegistrationPage, type RegistrationStatus } from '@picklyph/domain';
import { readDirectoryAccess } from '@/lib/directory-server';
import { readRegistrationsPage } from '@/lib/registrations-handler';
import { AccessProblem, Unavailable } from '@/components/console-state';
import { PageHeader } from '@/components/page-header';
import { RegistrationList, type RegistrationStamps } from '@/components/registration-list';
import { toDisplayInstant } from '@/lib/ownership';

const TABS: { key: RegistrationStatus | null; label: string; empty: string }[] = [
  { key: null, label: 'All', empty: 'No registrations yet.' },
  { key: 'open', label: 'Open', empty: 'No open registrations.' },
  { key: 'claimed', label: 'Claimed', empty: 'No registration has been claimed yet.' },
  { key: 'erased', label: 'Erased', empty: 'No erased registrations.' },
];
const pageHref = (status: RegistrationStatus | null, email: string | null, after?: string) => {
  const query = new URLSearchParams();
  if (status) query.set('status', status);
  if (email) query.set('email', email);
  if (after) query.set('after', after);
  return query.size ? `/console/registrations?${query}` : '/console/registrations';
};
// Formatted on the server so the browser hydrates the same text.
const stamp = (value: string | null) => { if (!value) return null; try { return formatManilaDateTime(toDisplayInstant(value)); } catch { return null; } };
const count = (page: AdminRegistrationPage, status: RegistrationStatus | null) =>
  status ? page.counts[status] : page.counts.open + page.counts.claimed + page.counts.erased;

export default async function RegistrationsPage({ searchParams }: { searchParams: Promise<{ status?: string; email?: string; after?: string }> }) {
  // Layouts may persist in the router. Every data-bearing page verifies independently.
  const access = await readDirectoryAccess();
  if (access.status !== 'allowed') return <AccessProblem area="registrations" status={access.status} />;
  const params = await searchParams;
  const status = readRegistrationStatus(params.status);
  let email: string | null = null;
  let searchProblem = '';
  try { email = readRegistrationEmailFilter(params.email); } catch (error) { searchProblem = error instanceof PrelaunchInputError ? error.message : 'Enter a full email address.'; }
  const cursor = (() => { try { return readReviewCursor(params.after); } catch { return null; } })();
  const page = await (async () => { try { return await readRegistrationsPage(access.actorId, status, email, cursor); } catch { return null; } })();
  if (!page) return <Unavailable area="registrations" />;
  const tab = TABS.find((item) => item.key === status) ?? TABS[0]!;
  const stamps: Record<string, RegistrationStamps> = Object.fromEntries(page.items.map((item) => [item.id, {
    registered: stamp(item.registered_at), emailed: stamp(item.email_sent_at), claimed: stamp(item.claimed_at), erased: stamp(item.erased_at) }]));

  return <>
    <PageHeader title="Pre-launch registrations" meta="Court owners who registered on the pre-launch page. Their contact details are private to administrators; send new claim codes at launch and erase spam or anyone who asks to be removed." />
    <section className="panel" aria-label="Registrations">
      <nav className="tabs" aria-label="Filter registrations by status">{TABS.map((item) =>
        <Link key={item.label} href={pageHref(item.key, email)} aria-current={item.key === tab.key ? 'page' : undefined}>{`${item.label} (${count(page, item.key)})`}</Link>)}</nav>
      <form className="table-search" role="search" action="/console/registrations">
        {status && <input type="hidden" name="status" value={status} />}
        <label className="sr-only" htmlFor="registration-email">Registration email</label>
        <input id="registration-email" name="email" type="email" defaultValue={email ?? params.email ?? ''} placeholder="Find by email address" autoComplete="off" spellCheck={false} />
        <button className="button secondary compact" type="submit">Search</button>
        {(email || searchProblem) && <Link className="button secondary compact" href={pageHref(status, null)}>Clear</Link>}
        {searchProblem && <span className="field-error" role="alert">{searchProblem}</span>}
      </form>
      {page.items.length
        ? <RegistrationList key={`${status ?? 'all'}:${email ?? ''}:${params.after ?? ''}`} items={page.items} stamps={stamps} />
        : <div className="empty-state"><h2>{cursor ? 'No more registrations.' : email ? 'No registrations for this address.' : tab.empty}</h2>
          <p>Registrations arrive from the public pre-launch page. Each one is a private draft listing until its owner claims it in the app.</p></div>}
      {(cursor || page.next_cursor) && <div className="panel-foot">{cursor && <Link className="button secondary compact" href={pageHref(status, email)}>Back to first page</Link>}
        {page.next_cursor && <Link className="button secondary compact" href={pageHref(status, email, formatReviewCursor(page.next_cursor))}>Next page</Link>}</div>}
    </section>
  </>;
}
