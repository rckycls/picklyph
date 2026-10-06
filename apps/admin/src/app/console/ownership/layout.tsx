import { redirect } from 'next/navigation';
import { readReviewAccess } from '@/lib/ownership-server';
import { DirectoryShell } from '@/components/directory-shell';
import { ReviewUnavailable } from '@/components/ownership-review';

export const dynamic = 'force-dynamic';
export default async function OwnershipLayout({ children }: { children: React.ReactNode }) {
  const access = await readReviewAccess();
  if (access.status === 'guest') redirect('/login');
  if (access.status === 'denied') return <DirectoryShell><section className="workspace-panel"><h1>Reviewer access required.</h1><p>Ownership review is available to administrators and moderators.</p></section></DirectoryShell>;
  if (access.status !== 'allowed') return <DirectoryShell><ReviewUnavailable /></DirectoryShell>;
  return <DirectoryShell>{children}</DirectoryShell>;
}
