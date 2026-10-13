'use client';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import type { PrivilegedRole } from '@picklyph/domain';
import { Icon, type IconName } from './icons';
import { SignoutButton } from './signout-button';

const NAV: { href: string; label: string; icon: IconName; adminOnly?: boolean }[] = [
  { href: '/console', label: 'Overview', icon: 'overview' },
  { href: '/console/directory', label: 'Court directory', icon: 'directory', adminOnly: true },
  { href: '/console/registrations', label: 'Pre-launch', icon: 'registrations', adminOnly: true },
  { href: '/console/ownership', label: 'Ownership review', icon: 'ownership' },
  { href: '/console/reports', label: 'Listing reports', icon: 'reports' },
  { href: '/console/health', label: 'System health', icon: 'health', adminOnly: true },
];
const ROLE_LABEL: Record<PrivilegedRole, string> = { admin: 'Administrator', moderator: 'Moderator' };

/** Console navigation. Hides sections the account can't open; each page still checks access itself. */
export function ConsoleSidebar({ email, roles }: { email: string | null; roles: PrivilegedRole[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current = (href: string) => href === '/console' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return <aside className="sidebar" data-open={open}>
    <div className="sidebar-top">
      <Link className="sidebar-brand" href="/console" prefetch={false} aria-label="pickly console" onClick={() => setOpen(false)}>
        <Image src="/mark.svg" width={20} height={30} alt="" unoptimized /><span>pickly</span><small>Console</small>
      </Link>
      <button className="sidebar-toggle" type="button" aria-expanded={open} aria-controls="console-menu" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'close' : 'menu'} /><span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
      </button>
    </div>
    <div className="sidebar-menu" id="console-menu">
      <nav aria-label="Console"><ul>{NAV.filter((item) => !item.adminOnly || roles.includes('admin')).map((item) =>
        <li key={item.href}><Link href={item.href} aria-current={current(item.href) ? 'page' : undefined} onClick={() => setOpen(false)}><Icon name={item.icon} />{item.label}</Link></li>)}</ul></nav>
      <div className="sidebar-account">
        <p className="account-email">{email ?? 'Signed-in account'}</p>
        <p className="account-roles">{roles.map((role) => ROLE_LABEL[role]).join(' · ')}</p>
        <SignoutButton />
      </div>
    </div>
  </aside>;
}
