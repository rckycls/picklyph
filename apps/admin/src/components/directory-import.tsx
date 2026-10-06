'use client';
import Link from 'next/link';
import { useState } from 'react';
import { readDirectoryImport, type DirectoryImportEntry, type DirectoryImportResult } from '@picklyph/domain';

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
  return <><div className="page-heading"><Link className="back-link" href="/console/directory">← Court directory</Link><p className="eyebrow">IMPORT LISTINGS</p><h1>A thoughtful start.</h1><p className="muted">Import 1–25 venues from details you have permission to use. Every new listing starts as a private draft.</p></div><section className="workspace-panel"><h2>Choose your JSON file</h2><p>Give each venue a permanent, unique reference. Retrying the same import keeps existing listings. To change an imported venue, edit its listing.</p><p><a href="/directory-import-example.json" download>Download a fictional example</a></p><label className="import-file">JSON file<input type="file" accept=".json,application/json" disabled={busy} onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 256 * 1024) { setPreview(null); setMessage('Use a JSON file smaller than 256 KiB.'); return; } try { change(await file.text()); } catch { setPreview(null); setMessage('The file could not be read.'); } }} /></label><label className="import-json">Listing data<textarea rows={14} value={text} disabled={busy} onChange={event => change(event.target.value)} spellCheck={false} maxLength={256 * 1024} /></label><button className="button secondary" disabled={busy || !text.trim()} onClick={review}>Validate and review</button></section>
    {preview && <section className="workspace-panel publication-panel"><h2>Review {preview.length} listings</h2><ul className="import-preview">{preview.map(entry => <li key={entry.reference}><strong>{entry.venue.name}</strong><span>{entry.venue.city}, {entry.venue.province} · {entry.courts.length} courts</span><code>{entry.reference}</code></li>)}</ul><button className="button primary" disabled={busy} onClick={() => void importListings()}>{busy ? 'Importing…' : 'Import as drafts'}</button></section>}
    <div className="directory-feedback" role="status" aria-live="polite"><p>{message}</p></div>{results.length > 0 && <section className="workspace-panel"><h2>Imported listings</h2><ul className="import-preview">{results.map(result => <li key={result.reference}><Link href={`/console/directory/${result.id}`}>{result.reference}</Link><span>{result.outcome === 'created' ? 'New draft' : 'Existing listing kept'}</span></li>)}</ul></section>}
  </>;
}
