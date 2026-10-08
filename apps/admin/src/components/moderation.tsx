'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { REPORT_REASONS, REPORT_REASON_LABELS, REVOCATION_REASONS, REVOCATION_REASON_LABELS, type ReportReason, type RevocationReason } from '@picklyph/domain';

export function ModerationUnavailable() {
  return <section className="workspace-panel"><h1>Reports unavailable.</h1><p>We couldn’t load listing reports. Try again shortly or contact the operator.</p><Link className="button secondary" href="/console/reports">Try again</Link></section>;
}

/** Sends one decision; the server re-checks access, ownership stake and report state. */
function useModeration(path: 'decide' | 'revoke') {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  async function send(body: Record<string, unknown>) {
    setBusy(true); setMessage(''); setConflict(false);
    try {
      const response = await fetch(`/api/console/moderation/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload: { data?: { outcome: 'decided' | 'existing' }; error?: string } = await response.json();
      if (!response.ok || !payload.data) { setConflict(response.status === 409); throw new Error(payload.error ?? 'The decision could not be saved.'); }
      setMessage(payload.data.outcome === 'existing' ? 'Nothing changed: this was already recorded.' : 'Decision saved.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The decision could not be saved.');
    } finally { setBusy(false); }
  }
  const feedback = <div className="directory-feedback" role="status" aria-live="polite"><p>{message}</p>{conflict && <button className="button secondary" type="button" onClick={() => window.location.reload()}>Reload listing</button>}</div>;
  return { busy, send, feedback };
}

type OpenReport = { id: string; label: string };
/** Open reports the reviewer has seen, plus suspension of a published listing. */
export function ReportDecisionForm({ venueId, reports, published }: { venueId: string; reports: OpenReport[]; published: boolean }) {
  const { busy, send, feedback } = useModeration('decide');
  const [selected, setSelected] = useState<string[]>(reports.map(report => report.id));
  const [reason, setReason] = useState<ReportReason>('unsafe');
  const [confirmed, setConfirmed] = useState(false);
  const toggle = (id: string, on: boolean) => setSelected(current => on ? [...current, id] : current.filter(value => value !== id));
  return <section className="workspace-panel decision-panel" aria-labelledby="report-decision-heading">
    <h2 id="report-decision-heading">Decision</h2>
    <fieldset disabled={busy}>
      {reports.length > 0 && <><p className="muted small-note">Decisions apply to the reports ticked here. Reports that arrive later stay open.</p>
        {reports.map(report => <label className="check-row" key={report.id}><input type="checkbox" checked={selected.includes(report.id)} onChange={event => toggle(report.id, event.target.checked)} />{report.label}</label>)}
        <div className="decision-option"><h3>Keep the listing</h3><p className="muted small-note">Dismiss reports that need no change, or mark them resolved after the listing was corrected.</p>
          <div className="directory-actions"><button className="button secondary" type="button" disabled={selected.length === 0} onClick={() => void send({ venue_id: venueId, decision: 'dismiss', reason: null, report_ids: selected })}>Dismiss selected</button>
            <button className="button secondary" type="button" disabled={selected.length === 0} onClick={() => void send({ venue_id: venueId, decision: 'resolve', reason: null, report_ids: selected })}>Mark resolved</button></div></div></>}
      {published && <div className="decision-option"><h3>Suspend the listing</h3><p className="muted small-note">Removes it from Discover and stops every new booking at once. Existing bookings stay; players can still cancel. Ticked reports are marked resolved.</p>
        <div className="field-grid"><label className="wide-field">Reason<select value={reason} onChange={event => setReason(REPORT_REASONS.find(value => value === event.target.value) ?? 'other')}>{REPORT_REASONS.map(value => <option key={value} value={value}>{REPORT_REASON_LABELS[value]}</option>)}</select></label></div>
        <label className="check-row"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I checked the listing and the reports.</label>
        <div className="directory-actions"><button className="button primary" type="button" disabled={!confirmed} onClick={() => void send({ venue_id: venueId, decision: 'suspend', reason, report_ids: selected })}>Suspend listing</button></div></div>}
    </fieldset>
    {feedback}
  </section>;
}

export function ReinstateForm({ venueId }: { venueId: string }) {
  const { busy, send, feedback } = useModeration('decide');
  return <section className="workspace-panel decision-panel"><h2>Lift the suspension</h2>
    <p className="muted small-note">Publishes the listing on Discover again with its current details, and new bookings resume.</p>
    <div className="directory-actions"><button className="button primary" type="button" disabled={busy} onClick={() => void send({ venue_id: venueId, decision: 'reinstate', reason: null, report_ids: [] })}>Lift suspension</button></div>
    {feedback}</section>;
}

type Owner = { user_id: string; label: string };
export function RevokeOwnerForm({ venueId, owners }: { venueId: string; owners: Owner[] }) {
  const { busy, send, feedback } = useModeration('revoke');
  const [owner, setOwner] = useState(owners[0]?.user_id ?? '');
  const [reason, setReason] = useState<RevocationReason>('not_owner');
  const [confirmed, setConfirmed] = useState(false);
  return <section className="workspace-panel decision-panel" aria-labelledby="revoke-heading"><h2 id="revoke-heading">Remove an owner</h2>
    <p className="muted small-note">They lose management of this listing at once. Removing the last owner makes the listing unclaimed, which stops new bookings until a reviewed claim verifies someone again. Existing bookings stay.</p>
    <fieldset disabled={busy}>
      <div className="field-grid"><label className="wide-field">Owner<select value={owner} onChange={event => setOwner(event.target.value)}>{owners.map(item => <option key={item.user_id} value={item.user_id}>{item.label}</option>)}</select></label>
        <label className="wide-field">Reason<select value={reason} onChange={event => setReason(REVOCATION_REASONS.find(value => value === event.target.value) ?? 'other')}>{REVOCATION_REASONS.map(value => <option key={value} value={value}>{REVOCATION_REASON_LABELS[value]}</option>)}</select></label></div>
      <label className="check-row"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirmed this person should no longer manage the listing.</label>
      <div className="directory-actions"><button className="button secondary" type="button" disabled={!confirmed || !owner} onClick={() => void send({ venue_id: venueId, owner_user_id: owner, reason })}>Remove owner</button></div>
    </fieldset>
    {feedback}</section>;
}
