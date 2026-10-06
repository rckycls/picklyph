'use client';
import { useState, type FormEvent } from 'react';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [retryAt, setRetryAt] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/auth/${sent ? 'verify' : 'request'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, ...(sent ? { code } : {}) }), signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) { setMessage(result.error ?? 'Sign-in is unavailable. Please retry.'); return; }
      if (sent) {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Full reload discards prior-account router cache after cookie auth changes.
        window.location.assign('/console');
        return;
      }
      setSent(true); setRetryAt(Date.now() + 60000);
      setMessage('If this email belongs to an existing account, a code is on its way.');
    } catch { setMessage('Could not connect. Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="auth-form">
    <label htmlFor="email">Email address</label>
    <input id="email" name="email" type="email" autoComplete="email" maxLength={254} required value={email} disabled={busy || sent} onChange={(event) => setEmail(event.target.value)} />
    {sent && <><label htmlFor="code">Email verification code</label><input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6,10}" minLength={6} maxLength={10} required autoFocus value={code} disabled={busy} onChange={(event) => setCode(event.target.value)} /></>}
    <p className="form-message" role="status" aria-live="polite">{message}</p>
    <button className="button primary" disabled={busy} type="submit">{busy ? 'Please wait…' : sent ? 'Verify and sign in' : 'Send verification code'}<span aria-hidden="true">→</span></button>
    {sent && <button className="text-button" disabled={busy} type="button" onClick={() => {
      if (Date.now() < retryAt) { setMessage('Wait 60 seconds after the last request before requesting another code.'); return; }
      setSent(false); setCode(''); setMessage('Enter your email to request a new code.');
    }}>Change email or request a new code</button>}
  </form>;
}
