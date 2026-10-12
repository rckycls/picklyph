import { redirect } from 'next/navigation';
import { Brand } from '@/components/brand';
import { ConsoleSidebar } from '@/components/console-sidebar';
import { createAdminClient } from '@/lib/supabase';
import { readConsoleAccess } from '@/lib/access';

export const dynamic = 'force-dynamic';
/** The sidebar only renders for a verified console role. Pages check their own access and render their own denial. */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const access = await (async () => { try { return await readConsoleAccess(await createAdminClient()); } catch { return { status: 'unavailable' } as const; } })();
  if (access.status === 'guest') redirect('/login');
  if (access.status !== 'allowed') return <main id="main" className="state-shell"><Brand />{children}</main>;
  return <div className="console-app"><ConsoleSidebar email={access.email} roles={access.roles} /><main id="main" className="console-main">{children}</main></div>;
}
