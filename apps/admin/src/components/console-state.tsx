import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ConsoleAccess } from '@/lib/access';

const AREAS = {
  directory: { href: '/console/directory', denied: ['Administrator access required.', 'Directory curation is available to administrators.'],
    unavailable: ['Directory unavailable.', 'We couldn’t load the directory. Try again shortly or contact the operator.'] },
  registrations: { href: '/console/registrations', denied: ['Administrator access required.', 'Pre-launch registrations are available to administrators.'],
    unavailable: ['Registrations unavailable.', 'We couldn’t load pre-launch registrations. Try again shortly or contact the operator.'] },
  ownership: { href: '/console/ownership', denied: ['Reviewer access required.', 'Ownership review is available to administrators and moderators.'],
    unavailable: ['Review queue unavailable.', 'We couldn’t load ownership requests. Try again shortly or contact the operator.'] },
  reports: { href: '/console/reports', denied: ['Moderator access required.', 'Listing reports are available to administrators and moderators.'],
    unavailable: ['Reports unavailable.', 'We couldn’t load listing reports. Try again shortly or contact the operator.'] },
} as const;
type Area = keyof typeof AREAS;

/** A centred card for access problems and outages. Renders inside the console or, without access, on its own. */
export function ConsoleState({ label, title, children }: { label: string; title: string; children: React.ReactNode }) {
  return <section className="state-card"><span className="badge">{label}</span><h1>{title}</h1>{children}</section>;
}

export function Unavailable({ area }: { area: Area }) {
  const [title, body] = AREAS[area].unavailable;
  return <ConsoleState label="Unavailable" title={title}><p>{body}</p><Link className="button secondary" href={AREAS[area].href}>Try again</Link></ConsoleState>;
}

/** For a page whose own access check failed. Pages verify independently because layouts persist in the router. */
export function AccessProblem({ area, status }: { area: Area; status: Exclude<ConsoleAccess['status'], 'allowed'> }) {
  if (status === 'guest') redirect('/login');
  if (status === 'unavailable') return <Unavailable area={area} />;
  const [title, body] = AREAS[area].denied;
  return <ConsoleState label="Console access" title={title}><p>{body}</p><Link className="button secondary" href="/console">Back to overview</Link></ConsoleState>;
}
