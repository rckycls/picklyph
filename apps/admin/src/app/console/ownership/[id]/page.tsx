import Link from 'next/link';
import { notFound } from 'next/navigation';
import { REGISTRATION_ROLE_LABELS, REVIEW_REASON_LABELS, formatManilaDateTime, isUuid, type OwnershipReview, type RegistrationReview } from '@picklyph/domain';
import { readOwnershipReview, readReviewAccess } from '@/lib/ownership-server';
import { OwnershipDecisionForm } from '@/components/ownership-review';
import { AccessProblem, Unavailable } from '@/components/console-state';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { toDisplayInstant } from '@/lib/ownership';

const when = (value: string) => formatManilaDateTime(toDisplayInstant(value));

const mapLink = (latitude: number, longitude: number) => `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
const statusLabel = { pending: 'Awaiting review', approved: 'Approved', rejected: 'Rejected' } as const;
const listingLabel = (publication: string, claim: string) =>
  `${publication === 'approved' ? 'Published' : publication === 'suspended' ? 'Suspended' : 'Draft'} · ${claim === 'verified' ? 'Verified owner' : claim === 'pending' ? 'Claim pending' : 'Unclaimed'}`;

/** Directory pages are admin-only; moderators see the name without a dead link. */
function Listing({ id, name, admin }: { id: string; name: string; admin: boolean }) {
  return admin ? <Link href={`/console/directory/${id}`}>{name}</Link> : <>{name}</>;
}

function Outcome({ item, admin }: { item: OwnershipReview; admin: boolean }) {
  if (!item.review) return null;
  const { review } = item;
  return <Panel title="Decision" aside={<span className={`badge review-${item.status}`}>{statusLabel[item.status]}</span>}>
    <dl className="fact-list"><dt>Decided</dt><dd>{when(review.reviewed_at)}</dd>
      {review.reason && <><dt>Reason</dt><dd>{REVIEW_REASON_LABELS[review.reason]}</dd></>}
      {review.resolved_venue_id && <><dt>{review.resolution === 'new' ? 'Owner’s listing' : 'Merged into'}</dt><dd>{admin ? <Link href={`/console/directory/${review.resolved_venue_id}`}>Open listing</Link> : <code>{review.resolved_venue_id}</code>}</dd></>}</dl>
    {item.kind === 'venue' && item.draft && review.resolution !== 'new' && <p className="field-hint">The owner’s draft was retired and is not published.</p>}</Panel>;
}

/** T54: the pre-launch registration this request redeemed with its emailed code. Contacts reach admins only. */
function Registration({ registration, admin }: { registration: RegistrationReview; admin: boolean }) {
  const { contact } = registration;
  return <Panel title="Pre-launch registration"><dl className="fact-list">
    <dt>Registered</dt><dd>{when(registration.registered_at)} on the pre-launch page</dd>
    <dt>Code claimed</dt><dd>{when(registration.claimed_at)}</dd>
    <dt>Role at venue</dt><dd>{REGISTRATION_ROLE_LABELS[registration.role]}</dd>
    <dt>Account email</dt><dd>{registration.email_matched ? 'Matches the registration email' : 'Differs from the registration email'}</dd>
    {contact && <><dt>Registered by</dt><dd>{contact.owner_name}</dd>
      <dt>Email</dt><dd>{contact.email}</dd>
      <dt>Mobile</dt><dd>{contact.phone ?? 'Not given'}</dd></>}</dl>
    {contact?.note && <><h3>Note on the registration</h3><p className="submitter-note">{contact.note}</p></>}
    <p className="field-hint">{registration.erased ? 'The registration’s contact details were erased (30 days after the decision, or earlier by an administrator).'
      : admin ? 'Private to administrators. The contact details are erased 30 days after the decision.'
      : 'The registrant’s contact details are visible to administrators only.'}</p></Panel>;
}

export default async function OwnershipItemPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await readReviewAccess();
  if (access.status !== 'allowed') return <AccessProblem area="ownership" status={access.status} />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const item = await (async () => { try { return await readOwnershipReview(access.actorId, id.toLowerCase()); } catch { return undefined; } })();
  if (item === undefined) return <Unavailable area="ownership" />;
  if (item === null) notFound();
  const admin = access.roles.includes('admin');
  const own = item.submitter.id === access.actorId;
  const name = item.kind === 'claim' ? item.venue.name : item.draft?.name ?? item.proposed.name;
  const candidates = item.kind === 'venue' ? item.nearby_venues.filter(venue => venue.publication_status !== 'suspended') : [];

  return <>
    <PageHeader crumbs={[{ href: '/console/ownership', label: 'Ownership review' }]} title={name}
      meta={<><span className={`badge kind-${item.kind}`}>{item.kind === 'claim' ? 'Ownership claim' : 'New venue'}</span> {item.kind === 'venue' && item.registration && <><span className="badge">Pre-launch</span> </>}<span className={`badge review-${item.status}`}>{statusLabel[item.status]}</span> Submitted {when(item.created_at)}</>} />
    <div className="review-layout"><div className="review-column">
      {item.kind === 'claim' ? <Panel title="Listing being claimed"><dl className="fact-list">
        <dt>Listing</dt><dd><Listing id={item.venue.id} name={item.venue.name} admin={admin} /></dd>
        <dt>Address</dt><dd>{item.venue.address_line}, {item.venue.city}, {item.venue.province}</dd>
        <dt>Pin</dt><dd><a href={mapLink(item.venue.latitude, item.venue.longitude)} target="_blank" rel="noopener noreferrer">{item.venue.latitude}, {item.venue.longitude}</a></dd>
        <dt>Status</dt><dd>{listingLabel(item.venue.publication_status, item.venue.claim_status)}</dd>
        <dt>Verified owners</dt><dd>{item.venue.owner_count}</dd>
        <dt>Other pending claims</dt><dd>{item.other_pending_claims}</dd></dl>
        {(item.venue.owner_count > 0 || item.other_pending_claims > 0) && <p className="notice">Others manage or are claiming this listing. Approving adds this person as another verified owner.</p>}</Panel>
      : <><Panel title={item.draft ? 'Owner’s venue' : 'Proposed venue'}>{item.draft ? <><dl className="fact-list">
        <dt>Listing</dt><dd><Listing id={item.draft.id} name={item.draft.name} admin={admin} /></dd>
        <dt>Address</dt><dd>{item.draft.address_line}, {item.draft.city}, {item.draft.province}</dd>
        <dt>Pin</dt><dd><a href={mapLink(item.draft.latitude, item.draft.longitude)} target="_blank" rel="noopener noreferrer">{item.draft.latitude}, {item.draft.longitude}</a></dd>
        <dt>Status</dt><dd>{listingLabel(item.draft.publication_status, item.draft.claim_status)}</dd>
        <dt>Active courts</dt><dd>{item.draft.active_court_count}</dd>
        <dt>Photos</dt><dd>{item.draft.photo_count}</dd>
        <dt>As submitted</dt><dd>{item.proposed.name} · {item.proposed.court_count} {item.proposed.court_count === 1 ? 'court' : 'courts'}</dd>
        <dt>Nearby listings</dt><dd>{item.duplicates_acknowledged ? 'Submitter said it isn’t one of the public listings shown nearby.' : 'No public listings were shown nearby.'}</dd></dl>
        <p className="field-hint">The owner can keep editing this private draft while it awaits review. Check the listing before approving.</p></>
      : <dl className="fact-list">
        <dt>Name</dt><dd>{item.proposed.name}</dd>
        <dt>Address</dt><dd>{item.proposed.address_line}, {item.proposed.city}, {item.proposed.province}</dd>
        <dt>Pin</dt><dd><a href={mapLink(item.proposed.latitude, item.proposed.longitude)} target="_blank" rel="noopener noreferrer">{item.proposed.latitude}, {item.proposed.longitude}</a></dd>
        <dt>Courts</dt><dd>{item.proposed.court_count}</dd>
        <dt>Nearby listings</dt><dd>{item.duplicates_acknowledged ? 'Submitter said it isn’t one of the public listings shown nearby.' : 'No public listings were shown nearby.'}</dd></dl>}</Panel>
        <Panel title="Possible duplicates"><p className="field-hint">Listings within 150 m, or with a similar name within 2 km, including drafts and suspended listings the submitter never saw.</p>
          {item.nearby_venues.length ? <ul className="nearby-list">{item.nearby_venues.map(venue => <li key={venue.id}><div><strong><Listing id={venue.id} name={venue.name} admin={admin} /></strong><span className="muted"> · {venue.distance_m} m · {venue.city}</span></div><span className="muted small-note">{listingLabel(venue.publication_status, venue.claim_status)}{venue.in_snapshot ? '' : ' · found after submission'}</span></li>)}</ul> : <p className="muted">No listings nearby.</p>}
          <h3>Other submissions here</h3>
          {item.nearby_submissions.length ? <ul className="nearby-list">{item.nearby_submissions.map(other => <li key={other.id}><div><strong><Link href={`/console/ownership/${other.id}`}>{other.name}</Link></strong><span className="muted"> · {other.distance_m} m · {statusLabel[other.status]}</span></div>{other.same_submitter && <span className="muted small-note">Same submitter</span>}</li>)}</ul> : <p className="muted">No other submissions within 150 m.</p>}</Panel>
        {item.registration && <Registration registration={item.registration} admin={admin} />}</>}
      <Panel title="Submitter"><dl className="fact-list">
        <dt>Name</dt><dd>{item.submitter.display_name ?? 'No display name'}</dd>
        <dt>Account</dt><dd><code>{item.submitter.id}</code></dd>
        <dt>Joined</dt><dd>{when(item.submitter.joined_at)}</dd>
        <dt>Requests</dt><dd>{item.submitter.pending} pending · {item.submitter.approved} approved · {item.submitter.rejected} rejected</dd></dl>
        {item.note && <><h3>Note from submitter</h3><p className="submitter-note">{item.note}</p></>}</Panel>
    </div><div className="review-column">
      <Panel title="Proof photo">
        {item.evidence_removed_at
          ? <p className="muted">Removed on {when(item.evidence_removed_at)}, 30 days after the decision. The decision and its reason stay.</p>
          : <>
            {/* Private evidence must never enter the image optimizer cache; this route streams it with no-store. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="evidence-photo" src={`/api/console/ownership/evidence/${item.id}`} alt={`Proof photo submitted for ${name}`} />
            <p className="field-hint">Private to reviewers. Don’t download or share it. It is removed 30 days after the decision.</p></>}</Panel>
      {item.status !== 'pending' ? <Outcome item={item} admin={admin} />
        : own ? <Panel title="Decision"><p>You submitted this request, so another reviewer must decide it.</p></Panel>
        : <OwnershipDecisionForm subjectId={item.id} kind={item.kind} isAdmin={admin} candidates={candidates} />}
    </div></div>
  </>;
}
