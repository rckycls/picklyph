import { redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase';
import { readConsoleAccess } from '@/lib/access';
import { DirectoryShell, DirectoryUnavailable } from '@/components/directory-shell';

export const dynamic = 'force-dynamic';
export default async function DirectoryLayout({ children }: { children: React.ReactNode }) {
  const access = await (async () => { try { return await readConsoleAccess(await createAdminClient(), 'admin'); } catch { return { status: 'unavailable' } as const; } })();
  if (access.status === 'guest') redirect('/login');
  if (access.status === 'denied') return <DirectoryShell><section className="workspace-panel"><h1>Administrator access required.</h1><p>Directory curation is available to administrators.</p></section></DirectoryShell>;
  if (access.status !== 'allowed') return <DirectoryShell><DirectoryUnavailable /></DirectoryShell>;
  return <DirectoryShell>{children}</DirectoryShell>;
}
