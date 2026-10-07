import Link from 'next/link';
import { notFound } from 'next/navigation';
import { REVIEW_REASON_LABELS, formatManilaDateTime, isUuid, type OwnershipReview } from '@picklyph/domain';
import { readOwnershipReview, readReviewAccess } from '@/lib/ownership-server';
import { OwnershipDecisionForm, ReviewUnavailable } from '@/components/ownership-review';
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
  return <section className="workspace-panel"><div className="panel-top"><h2>Decision</h2><span className={`badge review-${item.status}`}>{statusLabel[item.status]}</span></div>
    <dl className="fact-list"><dt>Decided</dt><dd>{when(review.reviewed_at)}</dd>
      {review.reason && <><dt>Reason</dt><dd>{REVIEW_REASON_LABELS[review.reason]}</dd></>}
      {review.resolved_venue_id && <><dt>{review.resolution === 'new' ? 'New draft listing' : 'Merged into'}</dt><dd>{admin ? <Link href={`/console/directory/${review.resolved_venue_id}`}>Open listing</Link> : <code>{review.resolved_venue_id}</code>}</dd></>}</dl>
    {review.resolution === 'new' && <p className="muted small-note">The new listing is a private draft. An administrator publishes it after checking its courts and pin.</p>}</section>;
}

export default async function OwnershipItemPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await readReviewAccess();
  if (access.status !== 'allowed') return <ReviewUnavailable />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const item = await (async () => { try { return await readOwnershipReview(access.actorId, id.toLowerCase()); } catch { return undefined; } })();
  if (item === undefined) return <ReviewUnavailable />;
  if (item === null) notFound();
  const admin = access.roles.includes('admin');
  const own = item.submitter.id === access.actorId;
  const name = item.kind === 'claim' ? item.venue.name : item.proposed.name;
  const candidates = item.kind === 'venue' ? item.nearby_venues.filter(venue => venue.publication_status !== 'suspended') : [];

  return <><div className="page-heading"><Link className="back-link" href="/console/ownership">← Ownership review</Link><p className="eyebrow">{item.kind === 'claim' ? 'OWNERSHIP CLAIM' : 'NEW VENUE SUBMISSION'}</p><h1>{name}</h1><p className="muted">Submitted {when(item.created_at)} · <span className={`badge review-${item.status}`}>{statusLabel[item.status]}</span></p></div>
    <div className="review-layout"><div className="review-column">
      {item.kind === 'claim' ? <section className="workspace-panel"><h2>Listing being claimed</h2><dl className="fact-list">
        <dt>Listing</dt><dd><Listing id={item.venue.id} name={item.venue.name} admin={admin} /></dd>
        <dt>Address</dt><dd>{item.venue.address_line}, {item.venue.city}, {item.venue.province}</dd>
        <dt>Pin</dt><dd><a href={mapLink(item.venue.latitude, item.venue.longitude)} target="_blank" rel="noopener noreferrer">{item.venue.latitude}, {item.venue.longitude}</a></dd>
        <dt>Status</dt><dd>{listingLabel(item.venue.publication_status, item.venue.claim_status)}</dd>
        <dt>Verified owners</dt><dd>{item.venue.owner_count}</dd>
        <dt>Other pending claims</dt><dd>{item.other_pending_claims}</dd></dl>
        {(item.venue.owner_count > 0 || item.other_pending_claims > 0) && <p className="notice">Others manage or are claiming this listing. Approving adds this person as another verified owner.</p>}</section>
      : <><section className="workspace-panel"><h2>Proposed venue</h2><dl className="fact-list">
        <dt>Name</dt><dd>{item.proposed.name}</dd>
        <dt>Address</dt><dd>{item.proposed.address_line}, {item.proposed.city}, {item.proposed.province}</dd>
        <dt>Pin</dt><dd><a href={mapLink(item.proposed.latitude, item.proposed.longitude)} target="_blank" rel="noopener noreferrer">{item.proposed.latitude}, {item.proposed.longitude}</a></dd>
        <dt>Courts</dt><dd>{item.proposed.court_count}</dd>
        <dt>Nearby listings</dt><dd>{item.duplicates_acknowledged ? 'Submitter said it isn’t one of the public listings shown nearby.' : 'No public listings were shown nearby.'}</dd></dl></section>
        <section className="workspace-panel"><h2>Possible duplicates</h2><p className="muted small-note">Listings within 150 m, or with a similar name within 2 km, including drafts and suspended listings the submitter never saw.</p>
          {item.nearby_venues.length ? <ul className="nearby-list">{item.nearby_venues.map(venue => <li key={venue.id}><div><strong><Listing id={venue.id} name={venue.name} admin={admin} /></strong><span className="muted"> · {venue.distance_m} m · {venue.city}</span></div><span className="muted small-note">{listingLabel(venue.publication_status, venue.claim_status)}{venue.in_snapshot ? '' : ' · found after submission'}</span></li>)}</ul> : <p className="muted">No listings nearby.</p>}
          <h3>Other submissions here</h3>
          {item.nearby_submissions.length ? <ul className="nearby-list">{item.nearby_submissions.map(other => <li key={other.id}><div><strong><Link href={`/console/ownership/${other.id}`}>{other.name}</Link></strong><span className="muted"> · {other.distance_m} m · {statusLabel[other.status]}</span></div>{other.same_submitter && <span className="muted small-note">Same submitter</span>}</li>)}</ul> : <p className="muted">No other submissions within 150 m.</p>}</section></>}
      <section className="workspace-panel"><h2>Submitter</h2><dl className="fact-list">
        <dt>Name</dt><dd>{item.submitter.display_name ?? 'No display name'}</dd>
        <dt>Account</dt><dd><code>{item.submitter.id}</code></dd>
        <dt>Joined</dt><dd>{when(item.submitter.joined_at)}</dd>
        <dt>Requests</dt><dd>{item.submitter.pending} pending · {item.submitter.approved} approved · {item.submitter.rejected} rejected</dd></dl>
        {item.note && <><h3>Note from submitter</h3><p className="submitter-note">{item.note}</p></>}</section>
    </div><div className="review-column">
      <section className="workspace-panel"><h2>Proof photo</h2>
        {/* Private evidence must never enter the image optimizer cache; this route streams it with no-store. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="evidence-photo" src={`/api/console/ownership/evidence/${item.id}`} alt={`Proof photo submitted for ${name}`} />
        <p className="muted small-note">Private to reviewers. Don’t download or share it.</p></section>
      {item.status !== 'pending' ? <Outcome item={item} admin={admin} />
        : own ? <section className="workspace-panel"><h2>Decision</h2><p>You submitted this request, so another reviewer must decide it.</p></section>
        : <OwnershipDecisionForm subjectId={item.id} kind={item.kind} isAdmin={admin} candidates={candidates} />}
    </div></div></>;
}
