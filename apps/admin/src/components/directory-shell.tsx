import Link from 'next/link';
import { Brand } from './brand';
import { SignoutButton } from './signout-button';

export function DirectoryShell({ children }: { children: React.ReactNode }) {
  return <div className="console-shell"><header className="console-header"><Brand /><nav className="directory-nav" aria-label="Console"><Link href="/console">Workspace</Link><Link href="/console/directory">Directory</Link><Link href="/console/ownership">Ownership</Link><SignoutButton /></nav></header><main id="main" className="console-main">{children}</main></div>;
}
export function DirectoryUnavailable() {
  return <section className="workspace-panel"><h1>Directory unavailable.</h1><p>We couldn’t load the directory. Try again shortly or contact the operator.</p><Link className="button secondary" href="/console/directory">Try again</Link></section>;
}
