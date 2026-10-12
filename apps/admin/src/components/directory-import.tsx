'use client';
import Link from 'next/link';
import { useState } from 'react';
import { readDirectoryImport, type DirectoryImportEntry, type DirectoryImportResult } from '@picklyph/domain';
import { PageHeader } from './page-header';

export function DirectoryImport() {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<DirectoryImportEntry[] | null>(null);
  const [results, setResults] = useState<DirectoryImportResult[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  function change(value: string) { setText(value); setPreview(null); setResults([]); setMessage(''); }
  function review() {
    setMessage(''); setResults([]);
    try {
      if (new TextEncoder().encode(text).byteLength > 256 * 1024) throw new Error('Use a JSON file smaller than 256 KiB.');
      setPreview(readDirectoryImport(JSON.parse(text)));
    } catch (error) { setPreview(null); setMessage(error instanceof SyntaxError ? 'Enter valid JSON.' : error instanceof Error ? error.message : 'Check the import data.'); }
  }
  async function importListings() {
    if (!preview) return; setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/console/directory/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listings: preview }) });
      const payload: { data?: DirectoryImportResult[]; error?: string } = await response.json();
      if (!response.ok || !payload.data) throw new Error(payload.error ?? 'Import is unavailable.');
      setResults(payload.data); setMessage('Import complete. Review each draft before publishing.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Import is unavailable.'); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeader crumbs={[{ href: '/console/directory', label: 'Court directory' }]} title="Import listings"
      meta="Import 1–25 venues from details you have permission to use. Every new listing starts as a private draft." />
    <section className="panel" aria-labelledby="source-heading">
      <div className="panel-head"><h2 id="source-heading">1. Choose a JSON file</h2><a className="panel-link" href="/directory-import-example.json" download>Download a fictional example</a></div>
      <div className="panel-body">
        <p className="field-hint">Give each venue a permanent, unique reference. Retrying the same import keeps existing listings. To change an imported venue, edit its listing.</p>
        <label className="import-file">JSON file<input type="file" accept=".json,application/json" disabled={busy} onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 256 * 1024) { setPreview(null); setMessage('Use a JSON file smaller than 256 KiB.'); return; } try { change(await file.text()); } catch { setPreview(null); setMessage('The file could not be read.'); } }} /></label>
        <label className="import-json">Listing data<textarea rows={14} value={text} disabled={busy} onChange={event => change(event.target.value)} spellCheck={false} maxLength={256 * 1024} /></label>
        <button className="button secondary" disabled={busy || !text.trim()} onClick={review}>Validate and review</button>
      </div>
    </section>
    <div className="directory-feedback" role="status" aria-live="polite"><p>{message}</p></div>
    {preview && <section className="panel" aria-labelledby="preview-heading">
      <div className="panel-head"><h2 id="preview-heading">2. Review {preview.length} {preview.length === 1 ? 'listing' : 'listings'}</h2><button className="button primary compact" disabled={busy} onClick={() => void importListings()}>{busy ? 'Importing…' : 'Import as drafts'}</button></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">Venue</th><th scope="col">Location</th><th scope="col" className="num">Courts</th><th scope="col">Reference</th></tr></thead>
        <tbody>{preview.map(entry => <tr key={entry.reference}><td><strong>{entry.venue.name}</strong></td><td>{entry.venue.city}, {entry.venue.province}</td><td className="num">{entry.courts.length}</td><td><code>{entry.reference}</code></td></tr>)}</tbody></table></div>
    </section>}
    {results.length > 0 && <section className="panel" aria-labelledby="results-heading">
      <div className="panel-head"><h2 id="results-heading">Imported listings</h2></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">Reference</th><th scope="col">Outcome</th></tr></thead>
        <tbody>{results.map(result => <tr key={result.reference}><td><Link className="cell-link" href={`/console/directory/${result.id}`}>{result.reference}</Link></td><td>{result.outcome === 'created' ? <span className="badge publication-draft">New draft</span> : <span className="badge neutral">Existing listing kept</span>}</td></tr>)}</tbody></table></div>
    </section>}
  </>;
}
