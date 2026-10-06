'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { readDirectorySave, MAX_DIRECTORY_COURTS, type DirectoryListing, type CourtInput, type VenuePublicationStatus } from '@picklyph/domain';

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
  return <><div className="page-heading"><Link className="back-link" href="/console/directory">← Court directory</Link><p className="eyebrow">{listing ? 'VENUE DETAILS' : 'NEW VENUE'}</p><h1>{listing ? listing.name : 'Add a place to play.'}</h1><p className="muted">{listing ? 'Keep venue details and court information up to date.' : 'Start with a private draft. Review the details before publishing.'}</p></div>
    <form className="directory-form workspace-panel" onSubmit={event => { event.preventDefault(); void send('save'); }}>
      <fieldset disabled={busy}><legend>Venue information</legend><div className="field-grid">
        {(['name', 'address_line', 'city', 'province'] as const).map(name => <label key={name} className={name === 'address_line' || name === 'name' ? 'wide-field' : ''}>{({ name: 'Venue name', address_line: 'Street address', city: 'City / municipality', province: 'Province' })[name]}<input value={fields[name]} required maxLength={name === 'address_line' ? 240 : name === 'name' ? 120 : 80} onChange={event => updateField(name, event.target.value)} autoComplete="off" /></label>)}
        <label>Latitude<input type="number" step="any" min="-90" max="90" required value={fields.latitude} onChange={event => updateField('latitude', event.target.value)} /></label><label>Longitude<input type="number" step="any" min="-180" max="180" required value={fields.longitude} onChange={event => updateField('longitude', event.target.value)} /></label>
      </div><p className="muted small-note">Use the venue’s exact pin location. Listings are for the Philippines.</p></fieldset>
      <fieldset disabled={busy}><legend>Courts <span className="muted">({courts.length})</span></legend><p className="muted small-note">Keep existing courts and mark unavailable ones inactive. Published venues need at least one active court.</p>
        <div className="court-editor-list">{courts.map((court, index) => <section className="court-editor" key={court.id ?? `new-${index}`} aria-label={`Court ${index + 1}`}><div className="field-grid"><label className="wide-field">Court name<input required maxLength={80} value={court.name} onChange={event => updateCourt(index, { name: event.target.value })} /></label><label>Surface<select value={court.surface ?? ''} onChange={event => updateCourt(index, { surface: event.target.value === 'hard' ? 'hard' : event.target.value === 'synthetic' ? 'synthetic' : event.target.value === 'other' ? 'other' : null })}><option value="">Not specified</option><option value="hard">Hard</option><option value="synthetic">Synthetic</option><option value="other">Other</option></select></label><label>Status<select value={court.status} onChange={event => updateCourt(index, { status: event.target.value === 'active' ? 'active' : 'inactive' })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label></div><div className="court-amenities"><label><input type="checkbox" checked={court.is_indoor} onChange={event => updateCourt(index, { is_indoor: event.target.checked })} />Indoor</label><label><input type="checkbox" checked={court.is_covered} onChange={event => updateCourt(index, { is_covered: event.target.checked })} />Covered</label>{court.id === null && <button className="text-button" type="button" onClick={() => { setCourts(courts.filter((_, i) => i !== index)); setDirty(true); }}>Remove new court</button>}</div></section>)}</div>
        <button className="button secondary" type="button" disabled={courts.length >= MAX_DIRECTORY_COURTS} onClick={() => { setCourts([...courts, blankCourt()]); setDirty(true); }}>Add court</button>
      </fieldset><div className="directory-actions"><button className="button primary" type="submit" disabled={busy}>{busy ? 'Saving…' : listing ? 'Save changes' : 'Save draft'}</button>{dirty && <span className="muted small-note">Unsaved changes</span>}</div>
    </form>
    {listing && <section className="workspace-panel publication-panel"><div className="panel-top"><h2>Publication</h2><span className={`badge publication-${listing.publication_status}`}>{listing.publication_status === 'approved' ? 'Published' : listing.publication_status === 'suspended' ? 'Suspended' : 'Draft'}</span></div><p>Published listings appear in the public directory. Claim status: <strong>{listing.claim_status}</strong>. Publishing makes the venue discoverable; bookings need verified ownership and booking setup.</p><div className="directory-actions">{listing.publication_status !== 'approved' && <button className="button primary" disabled={busy || dirty} onClick={() => void send('publish', 'approved')}>Publish listing</button>}{listing.publication_status !== 'draft' && <button className="button secondary" disabled={busy || dirty} onClick={() => void send('publish', 'draft')}>Return to draft</button>}{listing.publication_status === 'approved' && <button className="button secondary" disabled={busy || dirty} onClick={() => void send('publish', 'suspended')}>Suspend listing</button>}</div>{dirty && <p className="small-note muted">Save your changes before changing publication.</p>}</section>}
    <div className="directory-feedback" role="status" aria-live="polite"><p>{message}</p>{conflict && <button className="button secondary" onClick={() => window.location.reload()}>Reload listing</button>}</div>
  </>;
}
