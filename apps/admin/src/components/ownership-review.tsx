'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { REVIEW_REASON_LABELS, REVIEW_REJECTION_REASONS, ReviewInputError, readOwnershipDecision, type OwnershipDecision, type ReviewRejectionReason } from '@picklyph/domain';

export function ReviewUnavailable() {
  return <section className="workspace-panel"><h1>Review queue unavailable.</h1><p>We couldn’t load ownership requests. Try again shortly or contact the operator.</p><Link className="button secondary" href="/console/ownership">Try again</Link></section>;
}

type Candidate = { id: string; name: string; city: string; distance_m: number };
export function OwnershipDecisionForm({ subjectId, kind, isAdmin, candidates }: { subjectId: string; kind: 'claim' | 'venue'; isAdmin: boolean; candidates: Candidate[] }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [target, setTarget] = useState(candidates[0]?.id ?? 'other');
  const [otherTarget, setOtherTarget] = useState('');
  const [reason, setReason] = useState<ReviewRejectionReason>('insufficient_evidence');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);

  async function send(input: Omit<OwnershipDecision, 'subject_id'>) {
    setBusy(true); setMessage(''); setConflict(false);
    try {
      const body = readOwnershipDecision({ subject_id: subjectId, ...input });
      const response = await fetch('/api/console/ownership/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload: { data?: { outcome: 'decided' | 'existing' }; error?: string } = await response.json();
      if (!response.ok || !payload.data) { setConflict(response.status === 409); throw new Error(payload.error ?? 'The decision could not be saved.'); }
      setMessage(payload.data.outcome === 'existing' ? 'This decision was already recorded.' : 'Decision saved.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof ReviewInputError ? 'Choose a listing or enter a valid listing ID.' : error instanceof Error ? error.message : 'The decision could not be saved.');
    } finally { setBusy(false); }
  }
  const mergeTarget = target === 'other' ? otherTarget.trim() : target;

  return <section className="workspace-panel decision-panel" aria-labelledby="decision-heading">
    <h2 id="decision-heading">Decision</h2>
    <fieldset disabled={busy}>
      <label className="check-row"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />I checked the proof photo, the details and any nearby listings.</label>
      {kind === 'claim' ? <div className="directory-actions"><button className="button primary" type="button" disabled={!checked} onClick={() => void send({ decision: 'approve', target_venue_id: null, rejection_reason: null })}>Approve ownership</button></div> : <>
        <div className="decision-option"><h3>New listing</h3><p className="muted small-note">Creates a private draft with these details and courts, owned by the submitter. Publish it from the directory after checking.</p>
          <button className="button primary" type="button" disabled={!checked || !isAdmin} onClick={() => void send({ decision: 'approve_new', target_venue_id: null, rejection_reason: null })}>Create draft listing and approve</button>
          {!isAdmin && <p className="muted small-note">Administrators only. Merge or reject it, or ask an administrator.</p>}</div>
        <div className="decision-option"><h3>Existing listing</h3><p className="muted small-note">The venue is already listed. The submitter becomes its verified owner.</p>
          <div className="field-grid"><label className="wide-field">Listing<select value={target} onChange={event => setTarget(event.target.value)}>{candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}, {candidate.city} ({candidate.distance_m} m)</option>)}<option value="other">Another listing ID…</option></select></label>
            {target === 'other' && <label className="wide-field">Listing ID<input value={otherTarget} onChange={event => setOtherTarget(event.target.value)} autoComplete="off" spellCheck={false} placeholder="00000000-0000-0000-0000-000000000000" /></label>}</div>
          <div className="directory-actions"><button className="button secondary" type="button" disabled={!checked || !mergeTarget} onClick={() => void send({ decision: 'merge', target_venue_id: mergeTarget, rejection_reason: null })}>Merge and approve</button></div></div>
      </>}
      <div className="decision-option"><h3>Reject</h3><div className="field-grid"><label className="wide-field">Reason<select value={reason} onChange={event => setReason(REVIEW_REJECTION_REASONS.find(value => value === event.target.value) ?? 'other')}>{REVIEW_REJECTION_REASONS.map(value => <option key={value} value={value}>{REVIEW_REASON_LABELS[value]}</option>)}</select></label></div>
        <div className="directory-actions"><button className="button secondary" type="button" onClick={() => void send({ decision: 'reject', target_venue_id: null, rejection_reason: reason })}>Reject request</button></div></div>
    </fieldset>
    <div className="directory-feedback" role="status" aria-live="polite"><p>{message}</p>{conflict && <button className="button secondary" type="button" onClick={() => window.location.reload()}>Reload request</button>}</div>
  </section>;
}
