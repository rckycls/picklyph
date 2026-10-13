'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { MAX_REGISTRATION_BATCH, REGISTRATION_ROLE_LABELS, codeDelivered, type AdminRegistration, type RegistrationAction,
  type RegistrationBatchResult } from '@picklyph/domain';

export type RegistrationStamps = { registered: string | null; emailed: string | null; claimed: string | null; erased: string | null };

const STATUS_LABEL = { open: 'Open', claimed: 'Claimed', erased: 'Erased' } as const;
const STATUS_CLASS = { open: 'badge registration-open', claimed: 'badge', erased: 'badge neutral' } as const;
const LISTING_LABEL = { approved: 'Published', suspended: 'Suspended', draft: 'Draft' } as const;
const plural = (n: number) => `${n} ${n === 1 ? 'registration' : 'registrations'}`;
const DONE: Record<RegistrationAction, string> = { send: 'sent a new code', erase: 'erased' };

/** One page of registrations with selection, Send new code and Erase (T54b). Each change still runs per registration on the server. */
export function RegistrationList({ items, stamps }: { items: AdminRegistration[]; stamps: Record<string, RegistrationStamps> }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState<RegistrationAction | null>(null);
  const [busy, setBusy] = useState<RegistrationAction | null>(null);
  const [message, setMessage] = useState('');
  const [skipped, setSkipped] = useState<{ id: string; name: string; message: string }[]>([]);
  const all = useRef<HTMLInputElement>(null);
  // Erased registrations have nothing left to send or erase.
  const selectable = items.filter((item) => item.status !== 'erased');
  const chosen = selectable.filter((item) => selected.has(item.id));
  const everything = selectable.length > 0 && chosen.length === selectable.length;
  const onlyOpen = chosen.every((item) => item.status === 'open');
  useEffect(() => { if (all.current) all.current.indeterminate = chosen.length > 0 && !everything; }, [chosen.length, everything]);

  function toggle(id: string) {
    setConfirming(null);
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleAll() { setConfirming(null); setSelected(everything ? new Set() : new Set(selectable.map((item) => item.id))); }

  async function run(action: RegistrationAction) {
    if (!chosen.length) return;
    if (chosen.length > MAX_REGISTRATION_BATCH) { setConfirming(null); setMessage(`Choose up to ${MAX_REGISTRATION_BATCH} registrations at a time.`); return; }
    setConfirming(null); setBusy(action); setMessage(''); setSkipped([]);
    try {
      const body = action === 'send' ? { items: chosen.map((item) => ({ id: item.id, code_version: item.code_version })) } : { ids: chosen.map((item) => item.id) };
      const response = await fetch(`/api/console/registrations/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const payload: { data?: RegistrationBatchResult; error?: string } = await response.json();
      if (!response.ok || !payload.data) throw new Error(payload.error ?? 'Registrations are unavailable.');
      const names = new Map(items.map((item) => [item.id, item.venue.name]));
      const notes = payload.data.outcomes.filter((outcome) => !outcome.done || outcome.message)
        .map((outcome) => ({ id: outcome.id, name: names.get(outcome.id) ?? outcome.id, message: outcome.message ?? 'Not changed.' }));
      const failed = payload.data.outcomes.filter((outcome) => !outcome.done);
      const done = payload.data.outcomes.length - failed.length;
      setMessage(`${plural(done)} ${DONE[action]}${failed.length ? `; ${failed.length} not:` : notes.length ? ':' : '.'}`);
      setSkipped(notes);
      // Registrations that didn't change stay selected, so they can be checked and retried.
      setSelected(new Set(failed.map((outcome) => outcome.id)));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Registrations are unavailable.');
    } finally { setBusy(null); }
  }

  const none = chosen.length === 0 || busy !== null;
  return <>
    <div className="table-toolbar" role="toolbar" aria-label="Registration actions">
      <span className="selection-count">{chosen.length ? `${chosen.length} selected` : `${plural(items.length)} on this page`}</span>
      <div className="bulk-buttons">
        <button className="button secondary compact" disabled={none || !onlyOpen} aria-expanded={confirming === 'send'} onClick={() => setConfirming('send')}>{busy === 'send' ? 'Sending…' : 'Send new code'}</button>
        <button className="button danger-outline compact" disabled={none} aria-expanded={confirming === 'erase'} onClick={() => setConfirming('erase')}>{busy === 'erase' ? 'Erasing…' : 'Erase'}</button>
      </div>
    </div>
    {chosen.length > 0 && !onlyOpen && <p className="field-hint table-hint">New codes go only to open registrations. Claimed ones were already redeemed.</p>}
    {confirming === 'send' && <div className="bulk-confirm" role="group" aria-label="Confirm sending codes">
      <p><strong>Email a new claim code to {plural(chosen.length)}?</strong> Each registrant gets a new code by email, and their earlier code stops working at once. Send at launch, or when someone lost their code.</p>
      <div><button className="button primary compact" onClick={() => void run('send')}>Send codes</button>
        <button className="button secondary compact" onClick={() => setConfirming(null)}>Cancel</button></div>
    </div>}
    {confirming === 'erase' && <div className="bulk-confirm" role="group" aria-label="Confirm erasing">
      <p><strong>Erase {plural(chosen.length)}?</strong> The registrants’ names, emails, phone numbers, notes and codes are deleted for good. An open registration’s draft listing is suspended; a claimed one keeps its draft, which is now the owner’s pending request in Ownership review. This can’t be undone.</p>
      <div><button className="button danger compact" onClick={() => void run('erase')}>Erase permanently</button>
        <button className="button secondary compact" onClick={() => setConfirming(null)}>Cancel</button></div>
    </div>}
    <div className="directory-feedback" role="status" aria-live="polite"><p>{message}</p>
      {skipped.length > 0 && <ul className="bulk-skipped">{skipped.map((item) => <li key={item.id}><strong>{item.name}</strong>: {item.message}</li>)}</ul>}</div>
    <div className="table-wrap"><table className="data-table">
      <thead><tr>
        <th scope="col" className="col-check"><input ref={all} type="checkbox" checked={everything} disabled={busy !== null || selectable.length === 0} onChange={toggleAll} aria-label="Select all on this page" /></th>
        <th scope="col">Venue</th><th scope="col">Registrant</th><th scope="col">Status</th><th scope="col">Code email</th><th scope="col">Registered</th>
      </tr></thead>
      <tbody>{items.map((item) => {
        const stamp = stamps[item.id];
        const undelivered = item.status === 'open' && !codeDelivered(item);
        return <tr key={item.id} className={selected.has(item.id) ? 'selected' : undefined}>
          <td className="col-check"><input type="checkbox" checked={selected.has(item.id)} disabled={busy !== null || item.status === 'erased'} onChange={() => toggle(item.id)} aria-label={`Select ${item.venue.name}`} /></td>
          <td><Link className="cell-link" href={`/console/directory/${item.venue.id}`}>{item.venue.name}</Link>
            <span className="cell-sub">{item.venue.city}, {item.venue.province} · {item.venue.court_count} {item.venue.court_count === 1 ? 'court' : 'courts'} · {LISTING_LABEL[item.venue.publication_status]}</span></td>
          <td>{item.contact ? <>{item.contact.owner_name}<span className="cell-sub">{item.contact.email}</span>
            <span className="cell-sub">{item.contact.phone ?? 'No mobile number'} · {REGISTRATION_ROLE_LABELS[item.role]}</span>
            {item.contact.note && <span className="cell-sub">“{item.contact.note}”</span>}</>
            : <span className="muted">Erased{stamp?.erased ? ` ${stamp.erased}` : ''}</span>}</td>
          <td><span className={STATUS_CLASS[item.status]}>{STATUS_LABEL[item.status]}</span>
            {item.status === 'claimed' && item.submission_id && <span className="cell-sub"><Link href={`/console/ownership/${item.submission_id}`}>Ownership review</Link>{stamp?.claimed ? ` · ${stamp.claimed}` : ''}</span>}
            {item.status === 'erased' && item.submission_id && <span className="cell-sub">Was claimed</span>}</td>
          <td className="nowrap">{stamp?.emailed ?? <span className="muted">Never delivered</span>}
            {undelivered && item.email_sent_at && <span className="cell-sub"><span className="badge registration-undelivered">Newest code not delivered</span></span>}
            {item.code_version > 1 && <span className="cell-sub">Code {item.code_version}</span>}</td>
          <td className="nowrap muted">{stamp?.registered}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </>;
}
