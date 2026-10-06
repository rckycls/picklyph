'use client';
import { useState } from 'react';

export function SignoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="signout"><button className="button secondary" disabled={busy} onClick={async () => {
    setBusy(true); setError('');
    try {
      const result = await fetch('/api/auth/signout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) });
      if (!result.ok) throw new Error('Sign-out unavailable');
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Full reload discards authenticated router cache after clearing the session.
      window.location.assign('/login');
    } catch { setError('Sign-out failed. Please retry.'); setBusy(false); }
  }}>{busy ? 'Signing out…' : 'Sign out'}</button><p role="status">{error}</p></div>;
}
