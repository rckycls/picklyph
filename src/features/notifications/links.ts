import { readPushData, toManilaDateTime, type PushData } from '@picklyph/domain';

/** Screens a tapped booking push may open (T44). Each screen still checks the account and its venue access. */
export type LinkTarget =
  | { pathname: '/rental/booking/[id]'; params: { id: string } }
  | { pathname: '/play/booking/[id]'; params: { id: string } }
  | { pathname: '/owner/requests/[id]'; params: { id: string } }
  | { pathname: '/owner/desk/[id]'; params: { id: string; date: string } };
export type PendingLink = { data: PushData; target: LinkTarget; owner: boolean; receivedAt: number; prompted: boolean };
/** A link still waiting (for sign-in, say) is forgotten after this long. */
export const LINK_LIFETIME_MS = 10 * 60_000;

/** Players open their booking; owners open booking requests, or the front desk on the booking's Manila day. */
export function linkTarget(data: PushData): { target: LinkTarget; owner: boolean } {
  if (data.audience === 'player') {
    return { owner: false, target: data.booking_kind === 'rental'
      ? { pathname: '/rental/booking/[id]', params: { id: data.booking_id } } : { pathname: '/play/booking/[id]', params: { id: data.booking_id } } };
  }
  if (data.kind === 'booking.requested') return { owner: true, target: { pathname: '/owner/requests/[id]', params: { id: data.venue_id } } };
  return { owner: true, target: { pathname: '/owner/desk/[id]', params: { id: data.venue_id, date: toManilaDateTime(data.starts_at).date } } };
}

export type LinkAuth = { status: 'restoring' | 'ready' | 'error'; user: string | null };
/** Owner mode's venue check: the count of venues this account manages now, or null while checking. */
export type LinkAccess = { count: number | null; error: boolean };
export type LinkStep =
  | { kind: 'wait' } | { kind: 'expired' } | { kind: 'sign_in' } | { kind: 'other_account' }
  | { kind: 'no_venue' } | { kind: 'access_unknown' } | { kind: 'open'; target: LinkTarget; owner: boolean };

/**
 * What to do with a tapped push now. It opens only for the account it was sent to; a signed-out phone
 * asks for sign-in and keeps the link for a while; owner links wait for the venue check.
 */
export function nextLinkStep(link: PendingLink, auth: LinkAuth, access: LinkAccess, now: number): LinkStep {
  if (auth.status === 'restoring') return { kind: 'wait' };
  if (now - link.receivedAt > LINK_LIFETIME_MS) return { kind: 'expired' };
  if (auth.status !== 'ready' || !auth.user) return { kind: 'sign_in' };
  if (auth.user.toLowerCase() !== link.data.recipient) return { kind: 'other_account' };
  if (link.owner) {
    if (access.error) return { kind: 'access_unknown' };
    if (access.count === null) return { kind: 'wait' };
    if (access.count === 0) return { kind: 'no_venue' };
  }
  return { kind: 'open', target: link.target, owner: link.owner };
}

/** The notice for a link that does not open. */
export function linkNotice(step: LinkStep): { title: string; body: string } | null {
  switch (step.kind) {
    case 'sign_in': return { title: 'Sign in to open this alert', body: 'Sign in with the account this alert was sent to, and it opens.' };
    case 'other_account': return { title: 'This alert is for another account', body: 'Sign in with that account to open it.' };
    case 'no_venue': return { title: 'Venue access needed', body: 'This account no longer manages that venue.' };
    case 'access_unknown': return { title: 'Couldn’t confirm your venue access', body: 'Open the venue from the Venues tab when you’re back online.' };
    default: return null;
  }
}

/** One pending link at a time; each notification is taken once, however often it is reported. */
export function createLinkStore() {
  let current: PendingLink | null = null;
  const seen = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    get: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    offer(raw: unknown, now: number): boolean {
      const data = readPushData(raw);
      if (!data || seen.has(data.notification_id)) return false;
      seen.add(data.notification_id);
      current = { data, ...linkTarget(data), receivedAt: now, prompted: false };
      emit();
      return true;
    },
    markPrompted(link: PendingLink) { if (current === link) { current = { ...link, prompted: true }; emit(); } },
    finish(link: PendingLink) { if (current === link) { current = null; emit(); } },
  };
}
