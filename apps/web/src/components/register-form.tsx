'use client';

import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { AddressCandidate, CourtSurface, PrelaunchDuplicate, PrelaunchErrorReply, PrelaunchReply } from '@picklyph/domain';
import {
  MAX_SUBMISSION_COURTS, PrelaunchInputError, REGISTRATION_ROLES, REGISTRATION_ROLE_LABELS, readAddressQuery, readPrelaunchRegistration,
  type RegistrationRole,
} from '@picklyph/domain';
import { VenueMap, type LatLng } from './venue-map';
import { TurnstileWidget } from './turnstile-widget';

const SURFACES: { value: '' | CourtSurface; label: string }[] = [
  { value: '', label: 'Not sure' }, { value: 'hard', label: 'Hard court' }, { value: 'synthetic', label: 'Synthetic' }, { value: 'other', label: 'Other' },
];
/** Close enough to see individual courts. */
const PIN_ZOOM = 15;

async function postJson(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  let data: unknown = null;
  try { data = await response.json(); } catch { /* An empty or non-JSON answer is handled as a failure below. */ }
  return { status: response.status, data };
}
/** A v4 UUID; randomUUID needs a secure context, which a phone testing a LAN dev server doesn't have. */
function newRequestKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const messageOf = (data: unknown, fallback: string) =>
  data && typeof data === 'object' && typeof (data as PrelaunchErrorReply).message === 'string' ? (data as PrelaunchErrorReply).message : fallback;

export function RegisterForm({ mapsKey, turnstileSiteKey }: { mapsKey: string; turnstileSiteKey: string }) {
  const router = useRouter();
  const requestKey = useRef<string>(newRequestKey());
  const alert = useRef<HTMLParagraphElement>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<AddressCandidate[] | null>(null);
  const [searchMessage, setSearchMessage] = useState('');
  const [focus, setFocus] = useState<(LatLng & { id: number }) | null>(null);
  const [pin, setPin] = useState<LatLng | null>(null);
  const [pinSet, setPinSet] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [venue, setVenue] = useState({ name: '', address_line: '', city: '', province: '' });
  const [courtCount, setCourtCount] = useState('1');
  const [indoor, setIndoor] = useState(false);
  const [covered, setCovered] = useState(false);
  const [surface, setSurface] = useState<'' | CourtSurface>('');
  const [owner, setOwner] = useState({ name: '', email: '', phone: '' });
  const [role, setRole] = useState<RegistrationRole | ''>('');
  const [note, setNote] = useState('');
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [duplicates, setDuplicates] = useState<PrelaunchDuplicate[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const fail = (message: string) => { setError(message); requestAnimationFrame(() => alert.current?.focus()); };
  const onPinChange = useCallback((point: LatLng, moved: boolean, level: number) => {
    setPin(point); setZoom(level);
    if (moved) setPinSet(true);
  }, []);

  async function search() {
    setSearchMessage(''); setCandidates(null);
    let address: string;
    try { address = readAddressQuery({ query }); } catch (problem) {
      setSearchMessage(problem instanceof PrelaunchInputError ? problem.message : 'Enter an address to search.'); return;
    }
    setSearching(true);
    try {
      const { status, data } = await postJson('/api/address', { query: address });
      const found = status === 200 && data && typeof data === 'object' ? (data as { candidates?: AddressCandidate[] }).candidates : null;
      if (!Array.isArray(found)) { setSearchMessage(messageOf(data, 'Address search is unavailable. Move the map to the venue instead.')); return; }
      setCandidates(found);
      if (found.length === 0) setSearchMessage('No matches in the Philippines. Try the barangay or city, or move the map to the venue.');
    } catch {
      setSearchMessage('Address search is unavailable. Check your connection, or move the map to the venue.');
    } finally { setSearching(false); }
  }

  function choose(candidate: AddressCandidate) {
    setCandidates(null);
    setSearchMessage(`Showing ${candidate.label}. Move the map if the pin isn’t exactly on your courts.`);
    setFocus((previous) => ({ lat: candidate.latitude, lng: candidate.longitude, id: (previous?.id ?? 0) + 1 }));
    setPinSet(true);
    setVenue((current) => ({ ...current, address_line: candidate.address_line, city: candidate.city || current.city, province: candidate.province || current.province }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!pin || !pinSet) return fail('Search for the address or move the map so the pin sits on your venue.');
    if (zoom < PIN_ZOOM) return fail('Zoom in on the map until you can see your courts, and put the pin on them.');
    let registration;
    try {
      registration = readPrelaunchRegistration({
        owner_name: owner.name, email: owner.email, phone: owner.phone, role: role || null,
        venue: { ...venue, latitude: Number(pin.lat.toFixed(6)), longitude: Number(pin.lng.toFixed(6)), court_count: Number(courtCount) },
        courts: { indoor, covered, surface: surface || null }, note, consent,
      });
    } catch (problem) {
      return fail(problem instanceof PrelaunchInputError ? problem.message : 'Check the form and try again.');
    }
    if (!token) return fail('Complete the security check above the button, then try again.');
    if (duplicates && !acknowledged) return fail('Confirm that your venue is not one of the listings shown.');
    setSubmitting(true);
    try {
      const { status, data } = await postJson('/api/register', {
        request_key: requestKey.current, turnstile_token: token, acknowledge_duplicates: acknowledged, registration,
      });
      const answer = status === 200 ? (data as PrelaunchReply | null) : null;
      if (answer?.status === 'sent') { router.push('/register/done'); return; }
      if (answer?.status === 'duplicates') {
        setDuplicates(answer.duplicates); setAcknowledged(false);
        return fail('There are listings on pickly near your pin. Check them below before you register.');
      }
      // A reused form can't be sent again: start a fresh registration with the same details.
      if (status === 409) requestKey.current = newRequestKey();
      fail(messageOf(data, 'Registration is unavailable right now. Try again in a few minutes.'));
    } catch {
      fail('We couldn’t reach pickly. Check your connection and try again.');
    } finally {
      setSubmitting(false);
      setResetKey((key) => key + 1);
    }
  }

  const courts = Number(courtCount);
  const setCourts = (value: number) => setCourtCount(String(Math.min(MAX_SUBMISSION_COURTS, Math.max(1, value))));

  return (
    <form onSubmit={submit} noValidate>
      <section className="card" aria-labelledby="where">
        <h2 id="where"><span className="step" aria-hidden="true">1</span>Where is your venue?</h2>
        <p className="hint">Search for the address, then drag the map (or tap) until the pin sits on your courts.</p>
        <div className="search">
          <label className="sr-only" htmlFor="address-search">Search for the address</label>
          <input id="address-search" type="search" enterKeyHint="search" autoComplete="street-address" placeholder="Street, barangay or city" value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} />
          <button className="button secondary" type="button" onClick={() => void search()} disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
        </div>
        {candidates && candidates.length > 0 && (
          <ul className="results" aria-label="Address matches">
            {candidates.map((candidate) => (
              <li key={`${candidate.latitude},${candidate.longitude},${candidate.label}`}>
                <button type="button" onClick={() => choose(candidate)}>{candidate.label}</button>
              </li>
            ))}
          </ul>
        )}
        <p className="pin-status" role="status">{searchMessage}</p>
        <VenueMap apiKey={mapsKey} focus={focus} onPinChange={onPinChange} />
        <p className={`pin-status${pinSet && zoom >= PIN_ZOOM ? ' set' : ''}`}>
          {!pinSet ? 'The pin isn’t placed yet.' : zoom < PIN_ZOOM ? 'Zoom in so the pin sits right on your courts.' : 'Pin placed. Adjust the map if it isn’t exactly on your courts.'}
        </p>
        {duplicates && duplicates.length > 0 && (
          <div className="notice" role="region" aria-label="Listings near your pin">
            <strong>Already on pickly near your pin:</strong>
            <ul>{duplicates.map((item) => <li key={`${item.name}-${item.distance_m}`}>{item.name}, {item.address_line}, {item.city} ({item.distance_m} m away)</li>)}</ul>
            If your venue is one of these, you can claim it in the app when pickly launches instead of registering it again.
            <label className="check"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />My venue is not one of these listings.</label>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="about-venue">
        <h2 id="about-venue"><span className="step" aria-hidden="true">2</span>About the venue</h2>
        <div className="field"><label htmlFor="venue-name">Venue name</label>
          <input id="venue-name" type="text" autoComplete="organization" maxLength={120} value={venue.name} onChange={(event) => setVenue({ ...venue, name: event.target.value })} /></div>
        <div className="field"><label htmlFor="venue-address">Street address</label>
          <input id="venue-address" type="text" autoComplete="address-line1" maxLength={240} value={venue.address_line} onChange={(event) => setVenue({ ...venue, address_line: event.target.value })} /></div>
        <div className="row">
          <div className="field"><label htmlFor="venue-city">City or municipality</label>
            <input id="venue-city" type="text" autoComplete="address-level2" maxLength={80} value={venue.city} onChange={(event) => setVenue({ ...venue, city: event.target.value })} /></div>
          <div className="field"><label htmlFor="venue-province">Province</label>
            <input id="venue-province" type="text" autoComplete="address-level1" maxLength={80} value={venue.province} onChange={(event) => setVenue({ ...venue, province: event.target.value })} /></div>
        </div>
      </section>

      <section className="card" aria-labelledby="about-courts">
        <h2 id="about-courts"><span className="step" aria-hidden="true">3</span>Courts</h2>
        <p className="hint">Roughly is fine. You can set each court up in the app after you claim the venue.</p>
        <div className="field"><label htmlFor="court-count">Number of pickleball courts</label>
          <div className="counter">
            <button className="button secondary" type="button" aria-label="One fewer court" onClick={() => setCourts((Number.isFinite(courts) ? courts : 1) - 1)}>−</button>
            <input id="court-count" type="number" inputMode="numeric" min={1} max={MAX_SUBMISSION_COURTS} value={courtCount} onChange={(event) => setCourtCount(event.target.value)} />
            <button className="button secondary" type="button" aria-label="One more court" onClick={() => setCourts((Number.isFinite(courts) ? courts : 0) + 1)}>+</button>
          </div>
        </div>
        <label className="check"><input type="checkbox" checked={indoor} onChange={(event) => setIndoor(event.target.checked)} />Indoor</label>
        <label className="check"><input type="checkbox" checked={covered} onChange={(event) => setCovered(event.target.checked)} />Covered (a roof over the courts)</label>
        <div className="field"><label htmlFor="court-surface">Surface</label>
          <select id="court-surface" value={surface} onChange={(event) => setSurface(event.target.value as '' | CourtSurface)}>
            {SURFACES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></div>
      </section>

      <section className="card" aria-labelledby="about-you">
        <h2 id="about-you"><span className="step" aria-hidden="true">4</span>About you</h2>
        <p className="hint">We email your claim code here. Nothing about you is shown in the app.</p>
        <div className="field"><label htmlFor="owner-name">Your name</label>
          <input id="owner-name" type="text" autoComplete="name" maxLength={120} value={owner.name} onChange={(event) => setOwner({ ...owner, name: event.target.value })} /></div>
        <div className="field"><label htmlFor="owner-email">Email</label>
          <input id="owner-email" type="email" autoComplete="email" inputMode="email" maxLength={254} value={owner.email}
            onChange={(event) => { setOwner({ ...owner, email: event.target.value }); requestKey.current = newRequestKey(); }} /></div>
        <div className="field"><label htmlFor="owner-phone">Mobile number <span className="optional">(optional)</span></label>
          <input id="owner-phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="0917 123 4567" maxLength={20} value={owner.phone} onChange={(event) => setOwner({ ...owner, phone: event.target.value })} /></div>
        <fieldset className="field">
          <legend className="legend">Your role at the venue</legend>
          <div className="choices">
            {REGISTRATION_ROLES.map((option) => (
              <label key={option}><input type="radio" name="role" value={option} checked={role === option} onChange={() => setRole(option)} /><span>{REGISTRATION_ROLE_LABELS[option]}</span></label>
            ))}
          </div>
        </fieldset>
        <div className="field"><label htmlFor="note">Anything we should know? <span className="optional">(optional)</span></label>
          <textarea id="note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="For example: the entrance, opening hours or other venues you run." /></div>
      </section>

      <section className="card" aria-labelledby="finish">
        <h2 id="finish"><span className="step" aria-hidden="true">5</span>Register</h2>
        <label className="check consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
          <span>I agree that pickly may keep these details to set up a private listing for my venue and email me a claim code, as described in the <a href="/privacy" target="_blank" rel="noopener">privacy notice</a>.</span></label>
        <TurnstileWidget siteKey={turnstileSiteKey} resetKey={resetKey} onToken={setToken} />
        <p className="alert" role="alert" tabIndex={-1} ref={alert}>{error}</p>
        <button className="button primary" type="submit" disabled={submitting} style={{ marginTop: 16 }}>
          {submitting ? 'Registering…' : duplicates ? 'Register my venue anyway' : 'Register my venue'}
        </button>
        <p className="fine">No account or password. Nothing is published until you claim your venue in the app and we review it.</p>
      </section>
    </form>
  );
}
