import { Brand } from '@/components/brand';
import { LoginForm } from '@/components/login-form';
import { readAdminConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';
export default function LoginPage() {
  let configured = true;
  try { readAdminConfig(process.env); } catch { configured = false; }
  return <main id="main" className="login-shell"><section className="login-intro">
    <Brand /><div className="intro-copy"><p className="eyebrow">PHILIPPINES · PICKLEBALL</p><h1>Good courts.<br />Great communities.</h1><p>Find a court. Run a court.<br />Keep every listing worth showing up for.</p></div><div className="court-lines" aria-hidden="true"><span /><span /><i /></div><p className="intro-footer">A better place to play starts here.</p>
  </section><section className="login-panel"><div className="login-card"><span className="badge">Admin &amp; moderator access</span><h2>Welcome to<br />the console.</h2><p className="muted">Sign in with the email linked to your pickly account. An administrator must grant your console access.</p>
    {configured ? <LoginForm /> : <p className="notice" role="status">Console setup is pending. Contact the operator to configure sign-in.</p>}
    <p className="auth-note">For players and court owners, use the pickly mobile app.</p>
  </div><p className="panel-footer">pickly · Philippines</p></section></main>;
}
