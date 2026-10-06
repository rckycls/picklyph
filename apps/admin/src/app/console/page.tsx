import { redirect } from 'next/navigation';
import { Brand } from '@/components/brand';
import { SignoutButton } from '@/components/signout-button';
import { createAdminClient } from '@/lib/supabase';
import { readConsoleAccess, type ConsoleAccess } from '@/lib/access';

export const dynamic = 'force-dynamic';
export default async function ConsolePage() {
  let access: ConsoleAccess;
  try { access = await readConsoleAccess(await createAdminClient()); } catch { access = { status: 'unavailable' }; }
  if (access.status === 'guest') redirect('/login');
  if (access.status !== 'allowed') return <main id="main" className="state-shell"><Brand /><section className="state-card"><span className="badge">Console access</span><h1>{access.status === 'denied' ? 'Access required.' : 'We couldn’t verify access.'}</h1><p>{access.status === 'denied' ? 'You’re signed in, but this account has no administrator or moderator assignment. Contact an administrator if you need console access.' : 'Sign-in or the permission service is unavailable. Try again shortly or contact the operator.'}</p><form action="/console" method="get"><button className="button primary" type="submit">Check again</button></form><SignoutButton /></section></main>;
  return <div className="console-shell"><header className="console-header"><Brand /><div className="account"><span>{access.email ?? 'Signed-in account'}</span><SignoutButton /></div></header><main id="main" className="console-main"><div className="page-heading"><p className="eyebrow">YOUR PICKLY WORKSPACE</p><h1>Welcome to the console.</h1><p className="muted">A home for better courts and thriving pickleball communities.</p><div className="role-list">{access.roles.map((role) => <span className="badge" key={role}>{role === 'admin' ? 'Administrator' : 'Moderator'}</span>)}</div></div><section className="workspace-panel"><div className="panel-top"><h2>Your workspace is ready.</h2><span className="status-dot">Access verified</span></div><p>Your current console permissions are confirmed. Directory tools will appear here as they become available.</p><div className="feature-grid"><article><span className="feature-number">01</span><h3>Court directory</h3><p>Keep venue information clear and useful.</p><span className="coming">Coming next</span></article><article><span className="feature-number">02</span><h3>Ownership review</h3><p>Connect courts with the people who run them.</p><span className="coming">Planned</span></article><article><span className="feature-number">03</span><h3>Community trust</h3><p>Help players find places they can count on.</p><span className="coming">Planned</span></article></div></section><p className="workspace-footer">Find a court. Run a court.</p></main></div>;
}
