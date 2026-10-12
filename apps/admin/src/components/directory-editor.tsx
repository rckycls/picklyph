'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readDirectorySave, MAX_DIRECTORY_COURTS, type DirectoryListing, type CourtInput, type VenueClaimStatus, type VenuePublicationStatus } from '@picklyph/domain';
import { Icon } from './icons';
import { PageHeader } from './page-header';

const STATUS_LABEL: Record<VenuePublicationStatus, string> = { approved: 'Published', suspended: 'Suspended', draft: 'Draft' };
const CLAIM_LABEL: Record<VenueClaimStatus, string> = { verified: 'Verified owner', pending: 'Claim pending', unclaimed: 'Unclaimed' };
const blankCourt = (): CourtInput => ({ id: null, name: '', surface: null, is_indoor: false, is_covered: false, status: 'active' });
export function DirectoryEditor({ initial }: { initial: DirectoryListing | null }) {
  const router = useRouter();
  const [listing, setListing] = useState(initial);
  const [fields, setFields] = useState({ name: initial?.name ?? '', address_line: initial?.address_line ?? '', city: initial?.city ?? '', province: initial?.province ?? '', latitude: initial ? String(initial.latitude) : '', longitude: initial ? String(initial.longitude) : '' });
  const [courts, setCourts] = useState<CourtInput[]>(initial?.courts.map(({ id, name, surface, is_indoor, is_covered, status }) => ({ id, name, surface, is_indoor, is_covered, status })) ?? [blankCourt()]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  function updateField(name: keyof typeof fields, value: string) { setFields({ ...fields, [name]: value }); setDirty(true); }
  function updateCourt(index: number, patch: Partial<CourtInput>) { setCourts(courts.map((court, i) => i === index ? { ...court, ...patch } : court)); setDirty(true); }
  async function send(operation: 'save' | 'publish', newStatus?: VenuePublicationStatus) {
    setMessage(''); setConflict(false); setBusy(true);
    try {
      const body = operation === 'save' ? readDirectorySave({ id: listing?.id ?? null, expected_updated_at: listing?.updated_at ?? null,
        venue: { ...fields, latitude: fields.latitude.trim() ? Number(fields.latitude) : NaN, longitude: fields.longitude.trim() ? Number(fields.longitude) : NaN }, courts })
        : { id: listing?.id, expected_updated_at: listing?.updated_at, publication_status: newStatus };
      const response = await fetch(`/api/console/directory/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload: { data?: DirectoryListing; error?: string } = await response.json();
      if (!response.ok || !payload.data) { setConflict(response.status === 409); throw new Error(payload.error ?? 'The change could not be saved.'); }
      const data = payload.data;
      setListing(data); setDirty(false);
      setCourts(data.courts.map(({ id, name, surface, is_indoor, is_covered, status }) => ({ id, name, surface, is_indoor, is_covered, status })));
      setFields({ name: data.name, address_line: data.address_line, city: data.city, province: data.province, latitude: String(data.latitude), longitude: String(data.longitude) });
      setMessage(operation === 'save' ? 'Listing saved.' : newStatus === 'approved' ? 'Listing published.' : newStatus === 'suspended' ? 'Listing suspended.' : 'Listing returned to draft.');
      if (!listing) router.replace(`/console/directory/${data.id}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The change could not be saved.'); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeader crumbs={[{ href: '/console/directory', label: 'Court directory' }]} title={listing ? listing.name : 'Add a venue'}
      meta={listing ? <><span className={`badge publication-${listing.publication_status}`}>{STATUS_LABEL[listing.publication_status]}</span> {listing.city}, {listing.province}</> : 'Start with a private draft. Review the details before publishing.'} />
    <div className="editor-layout">
      <form className="directory-form" onSubmit={event => { event.preventDefault(); void send('save'); }}>
        <section className="panel">
          <div className="panel-head"><h2 id="venue-heading">Venue information</h2></div>
          <fieldset className="panel-body" disabled={busy} aria-labelledby="venue-heading"><div className="field-grid">
            {(['name', 'address_line', 'city', 'province'] as const).map(name => <label key={name} className={name === 'address_line' || name === 'name' ? 'wide-field' : ''}>{({ name: 'Venue name', address_line: 'Street address', city: 'City / municipality', province: 'Province' })[name]}<input value={fields[name]} required maxLength={name === 'address_line' ? 240 : name === 'name' ? 120 : 80} onChange={event => updateField(name, event.target.value)} autoComplete="off" /></label>)}
            <label>Latitude<input type="number" step="any" min="-90" max="90" required value={fields.latitude} onChange={event => updateField('latitude', event.target.value)} /></label><label>Longitude<input type="number" step="any" min="-180" max="180" required value={fields.longitude} onChange={event => updateField('longitude', event.target.value)} /></label>
          </div><p className="field-hint">Use the venue’s exact pin location. Listings are for the Philippines.</p></fieldset>
        </section>
        <section className="panel">
          <div className="panel-head"><h2 id="courts-heading">Courts <span className="count">{courts.length}</span></h2></div>
          <fieldset className="panel-body" disabled={busy} aria-labelledby="courts-heading">
            <p className="field-hint">Keep existing courts and mark unavailable ones inactive. Published venues need at least one active court.</p>
            <div className="court-table">
              <div className="court-row court-head" aria-hidden="true"><span>Court name</span><span>Surface</span><span>Status</span><span>Amenities</span></div>
              {courts.map((court, index) => <div className="court-row" role="group" key={court.id ?? `new-${index}`} aria-label={`Court ${index + 1}`}>
                <label><span className="cell-label">Court name</span><input required maxLength={80} value={court.name} onChange={event => updateCourt(index, { name: event.target.value })} /></label>
                <label><span className="cell-label">Surface</span><select value={court.surface ?? ''} onChange={event => updateCourt(index, { surface: event.target.value === 'hard' ? 'hard' : event.target.value === 'synthetic' ? 'synthetic' : event.target.value === 'other' ? 'other' : null })}><option value="">Not specified</option><option value="hard">Hard</option><option value="synthetic">Synthetic</option><option value="other">Other</option></select></label>
                <label><span className="cell-label">Status</span><select value={court.status} onChange={event => updateCourt(index, { status: event.target.value === 'active' ? 'active' : 'inactive' })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
                <div className="court-amenities"><label><input type="checkbox" checked={court.is_indoor} onChange={event => updateCourt(index, { is_indoor: event.target.checked })} />Indoor</label><label><input type="checkbox" checked={court.is_covered} onChange={event => updateCourt(index, { is_covered: event.target.checked })} />Covered</label>
                  {court.id === null && <button className="text-button" type="button" onClick={() => { setCourts(courts.filter((_, i) => i !== index)); setDirty(true); }}>Remove</button>}</div>
              </div>)}
            </div>
            <button className="button secondary compact" type="button" disabled={courts.length >= MAX_DIRECTORY_COURTS} onClick={() => { setCourts([...courts, blankCourt()]); setDirty(true); }}><Icon name="plus" />Add court</button>
          </fieldset>
        </section>
        <div className="form-bar">
          <button className="button primary" type="submit" disabled={busy}>{busy ? 'Saving…' : listing ? 'Save changes' : 'Save draft'}</button>
          {dirty && <span className="unsaved">Unsaved changes</span>}
          <div className="directory-feedback" role="status" aria-live="polite"><p>{message}</p>{conflict && <button className="button secondary compact" type="button" onClick={() => window.location.reload()}>Reload listing</button>}</div>
        </div>
      </form>
      <aside className="editor-side">
        <section className="panel" aria-labelledby="publication-heading">
          <div className="panel-head"><h2 id="publication-heading">Publication</h2><span className={`badge publication-${listing?.publication_status ?? 'draft'}`}>{listing ? STATUS_LABEL[listing.publication_status] : 'Draft'}</span></div>
          {listing ? <div className="panel-body">
            <p className="field-hint">Published listings appear in the public directory. Publishing makes the venue discoverable; bookings need verified ownership and booking setup.</p>
            <div className="stack-actions">{listing.publication_status !== 'approved' && <button className="button primary" disabled={busy || dirty} onClick={() => void send('publish', 'approved')}>Publish listing</button>}{listing.publication_status !== 'draft' && <button className="button secondary" disabled={busy || dirty} onClick={() => void send('publish', 'draft')}>Return to draft</button>}{listing.publication_status === 'approved' && <button className="button secondary" disabled={busy || dirty} onClick={() => void send('publish', 'suspended')}>Suspend listing</button>}</div>
            {dirty && <p className="field-hint">Save your changes before changing publication.</p>}
          </div> : <div className="panel-body"><p className="field-hint">New listings are saved as private drafts. Publish from here once the draft is saved.</p></div>}
        </section>
        {listing && <section className="panel" aria-labelledby="details-heading">
          <div className="panel-head"><h2 id="details-heading">Details</h2></div>
          <dl className="fact-list panel-body"><dt>Claim status</dt><dd>{CLAIM_LABEL[listing.claim_status]}</dd>
            <dt>Courts</dt><dd>{listing.courts.filter(court => court.status === 'active').length} active of {listing.courts.length}</dd>
            <dt>Listing ID</dt><dd><code>{listing.id}</code></dd></dl>
        </section>}
      </aside>
    </div>
  </>;
}
