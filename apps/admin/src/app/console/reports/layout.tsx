import { redirect } from 'next/navigation';
import { readReviewAccess } from '@/lib/ownership-server';
import { DirectoryShell } from '@/components/directory-shell';
import { ModerationUnavailable } from '@/components/moderation';

export const dynamic = 'force-dynamic';
export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const access = await readReviewAccess();
  if (access.status === 'guest') redirect('/login');
  if (access.status === 'denied') return <DirectoryShell><section className="workspace-panel"><h1>Moderator access required.</h1><p>Listing reports are available to administrators and moderators.</p></section></DirectoryShell>;
  if (access.status !== 'allowed') return <DirectoryShell><ModerationUnavailable /></DirectoryShell>;
  return <DirectoryShell>{children}</DirectoryShell>;
}
