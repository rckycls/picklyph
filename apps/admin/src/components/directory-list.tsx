'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { MAX_DIRECTORY_IMPORT, directoryExport, type DirectoryBulkAction, type DirectoryBulkResult, type DirectoryListing } from '@picklyph/domain';

const STATUS_LABEL = { approved: 'Published', suspended: 'Suspended', draft: 'Draft' } as const;
const DONE: Record<DirectoryBulkAction, string> = { publish: 'published', draft: 'moved to draft', suspend: 'suspended', delete: 'deleted' };
const WORKING: Record<DirectoryBulkAction, string> = { publish: 'Publishing…', draft: 'Moving…', suspend: 'Suspending…', delete: 'Deleting…' };
const plural = (n: number) => `${n} ${n === 1 ? 'listing' : 'listings'}`;

/** One page of the directory with selection and bulk actions (2026-10-13). Each change still runs per listing on the server. */
export function DirectoryList({ items, updated }: { items: DirectoryListing[]; updated: Record<string, string> }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<DirectoryBulkAction | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState('');
  const [skipped, setSkipped] = useState<{ id: string; name: string; message: string }[]>([]);
  const all = useRef<HTMLInputElement>(null);
  const chosen = items.filter((venue) => selected.has(venue.id));
  const everything = items.length > 0 && chosen.length === items.length;
  useEffect(() => { if (all.current) all.current.indeterminate = chosen.length > 0 && !everything; }, [chosen.length, everything]);

  function toggle(id: string) {
    setConfirmDelete(false);
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleAll() { setConfirmDelete(false); setSelected(everything ? new Set() : new Set(items.map((venue) => venue.id))); }

  async function run(action: DirectoryBulkAction) {
    if (!chosen.length) return;
    setConfirmDelete(false); setBusy(action); setMessage(''); setSkipped([]);
    try {
      const response = await fetch('/api/console/directory/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, items: chosen.map((venue) => ({ id: venue.id, expected_updated_at: venue.updated_at })) }) });
      const payload: { data?: DirectoryBulkResult; error?: string } = await response.json();
      if (!response.ok || !payload.data) throw new Error(payload.error ?? 'Bulk actions are unavailable.');
      const names = new Map(items.map((venue) => [venue.id, venue.name]));
      const failed = payload.data.outcomes.filter((outcome) => !outcome.done)
        .map((outcome) => ({ id: outcome.id, name: names.get(outcome.id) ?? outcome.id, message: outcome.message ?? 'Not changed.' }));
      const done = payload.data.outcomes.length - failed.length;
      setMessage(`${plural(done)} ${DONE[action]}${failed.length ? `; ${failed.length} skipped:` : '.'}`);
      setSkipped(failed);
      // Skipped listings stay selected, so they can be fixed and retried.
      setSelected(new Set(failed.map((item) => item.id)));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Bulk actions are unavailable.');
    } finally { setBusy(null); }
  }

  function exportJson() {
    setConfirmDelete(false); setSkipped([]);
    if (chosen.length > MAX_DIRECTORY_IMPORT) { setMessage(`Export up to ${MAX_DIRECTORY_IMPORT} listings at a time (the import limit).`); return; }
    const file = new Blob([`${JSON.stringify(directoryExport(chosen), null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url; link.download = `pickly-directory-${new Date().toISOString().slice(0, 10)}.json`;
    link.click(); URL.revokeObjectURL(url);
    setMessage(`Exported ${plural(chosen.length)}. Import the file elsewhere to create drafts; importing it twice keeps the first ones.`);
  }

  const none = chosen.length === 0 || busy !== null;
  return <>
    <div className="table-toolbar" role="toolbar" aria-label="Bulk actions">
      <span className="selection-count">{chosen.length ? `${chosen.length} selected` : `${plural(items.length)} on this page`}</span>
      <div className="bulk-buttons">
        <button className="button secondary compact" disabled={none} onClick={() => void run('publish')}>{busy === 'publish' ? WORKING.publish : 'Publish'}</button>
        <button className="button secondary compact" disabled={none} onClick={() => void run('draft')}>{busy === 'draft' ? WORKING.draft : 'Move to draft'}</button>
        <button className="button secondary compact" disabled={none} onClick={() => void run('suspend')}>{busy === 'suspend' ? WORKING.suspend : 'Suspend'}</button>
        <button className="button secondary compact" disabled={none} onClick={exportJson}>Export JSON</button>
        <button className="button danger-outline compact" disabled={none} aria-expanded={confirmDelete} onClick={() => setConfirmDelete(true)}>{busy === 'delete' ? WORKING.delete : 'Delete'}</button>
      </div>
    </div>
    {confirmDelete && <div className="bulk-confirm" role="group" aria-label="Confirm deletion">
      <p><strong>Permanently delete {plural(chosen.length)}?</strong> Only drafts and suspended listings that were never used are deleted: no bookings, blocks, sessions, owners, claims, photos or reports. The others are skipped; suspend those instead. This can’t be undone.</p>
      <div><button className="button danger compact" onClick={() => void run('delete')}>Delete permanently</button>
        <button className="button secondary compact" onClick={() => setConfirmDelete(false)}>Cancel</button></div>
    </div>}
    <div className="directory-feedback" role="status" aria-live="polite"><p>{message}</p>
      {skipped.length > 0 && <ul className="bulk-skipped">{skipped.map((item) => <li key={item.id}><strong>{item.name}</strong>: {item.message}</li>)}</ul>}</div>
    <div className="table-wrap"><table className="data-table">
      <thead><tr>
        <th scope="col" className="col-check"><input ref={all} type="checkbox" checked={everything} disabled={busy !== null} onChange={toggleAll} aria-label="Select all on this page" /></th>
        <th scope="col">Venue</th><th scope="col">Location</th><th scope="col" className="num">Courts</th><th scope="col">Status</th><th scope="col">Updated</th>
      </tr></thead>
      <tbody>{items.map((venue) => {
        const inactive = venue.courts.filter((court) => court.status !== 'active').length;
        return <tr key={venue.id} className={selected.has(venue.id) ? 'selected' : undefined}>
          <td className="col-check"><input type="checkbox" checked={selected.has(venue.id)} disabled={busy !== null} onChange={() => toggle(venue.id)} aria-label={`Select ${venue.name}`} /></td>
          <td><Link className="cell-link" href={`/console/directory/${venue.id}`}>{venue.name}</Link><span className="cell-sub">{venue.address_line}</span></td>
          <td>{venue.city}, {venue.province}</td>
          <td className="num">{venue.courts.length}{inactive > 0 && <span className="cell-sub">{inactive} inactive</span>}</td>
          <td><span className={`badge publication-${venue.publication_status}`}>{STATUS_LABEL[venue.publication_status]}</span></td>
          <td className="nowrap muted">{updated[venue.id]}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </>;
}
