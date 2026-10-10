import { readNotificationPreferences, readPushData, readPushDeviceCommand, type NotificationPreferences, type NotificationTopic,
  type PushDeviceResult, type PushPlatform } from '@picklyph/domain';

import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from '../owner/venueClient';

// Pure client and registration logic for the push-devices Edge function (T43, T45), so Node tests drive
// them against the real handler. Expo and permission calls come in through `PushPorts` (see pushLive.ts).
export const PUSH_REJECTIONS = ['invalid_request', 'account_deleted'] as const;
export type PushFailure = HttpFailure<typeof PUSH_REJECTIONS[number]>;
export type PushOutcome = HttpOutcome<PushDeviceResult, typeof PUSH_REJECTIONS[number]>;
export type PreferencesOutcome = HttpOutcome<NotificationPreferences, typeof PUSH_REJECTIONS[number]>;

const post = (body: unknown, signal?: AbortSignal): RequestInit =>
  ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

function send(transport: OwnerHttpTransport, body: unknown, expected: PushDeviceResult['status']): Promise<PushOutcome> {
  return ownerRequest(transport, transport.endpoint, post(body), (raw) => {
    if (raw.status !== expected || Object.keys(raw).length !== 1) throw new Error('Unexpected push device response.');
    return { status: expected };
  }, PUSH_REJECTIONS);
}

/** Retry-safe: registering the same token again changes nothing. */
export function registerPushDevice(transport: OwnerHttpTransport, token: string, platform: PushPlatform): Promise<PushOutcome> {
  return send(transport, readPushDeviceCommand({ kind: 'register', token, platform }), 'registered');
}

/** Removes the token from the signed-in account only (sign-out, T45). */
export function unregisterPushDevice(transport: OwnerHttpTransport, token: string): Promise<PushOutcome> {
  return send(transport, readPushDeviceCommand({ kind: 'unregister', token }), 'removed');
}

/** The account's alert switches (T45): every phone of the account follows them. */
export function readAlertPreferences(transport: OwnerHttpTransport, signal?: AbortSignal): Promise<PreferencesOutcome> {
  return ownerRequest(transport, `${transport.endpoint}?section=preferences`, { method: 'GET', signal }, readNotificationPreferences, PUSH_REJECTIONS);
}

/** Replaces the whole muted set, so a retry or a late duplicate lands on the same answer. */
export function saveAlertPreferences(transport: OwnerHttpTransport, muted: readonly NotificationTopic[]): Promise<PreferencesOutcome> {
  const command = readPushDeviceCommand({ kind: 'preferences', muted: [...muted] });
  return ownerRequest(transport, transport.endpoint, post(command), (raw) => {
    const saved = readNotificationPreferences(raw);
    if (command.kind !== 'preferences' || saved.muted.join() !== command.muted.join()) throw new Error('Unexpected preferences response.');
    return saved;
  }, PUSH_REJECTIONS);
}

/**
 * Switch changes go out one at a time, and only the newest waiting set is sent after the one in
 * flight, so quick taps never land out of order. `onSettled` gets the server's answer for the last
 * set sent, or the failure.
 */
export function createPreferencesWriter(save: (muted: NotificationTopic[]) => Promise<PreferencesOutcome>, onSettled: (outcome: PreferencesOutcome) => void) {
  let waiting: NotificationTopic[] | null = null;
  let running = false;
  const drain = async () => {
    running = true;
    while (waiting) {
      const next = waiting; waiting = null;
      let outcome: PreferencesOutcome;
      try { outcome = await save(next); } catch { outcome = { ok: false, failure: { kind: 'network', retryAfterSeconds: null } }; }
      if (!waiting) onSettled(outcome);
    }
    running = false;
  };
  return {
    write(muted: NotificationTopic[]) { waiting = muted; if (!running) void drain(); },
    get busy() { return running; },
  };
}

/** Whether to show a push that arrives while the app is open: only one addressed to the signed-in account. */
export function shouldPresent(raw: unknown, signedIn: string | null): boolean {
  const data = readPushData(raw);
  return data !== null && signedIn !== null && data.recipient === signedIn.toLowerCase();
}

/** Notification permission as the app sees it; `unavailable` means this build or device cannot receive push. */
export type AlertPermission = 'granted' | 'undetermined' | 'denied' | 'unavailable';
export type PushPorts = {
  backend: string;
  platform: PushPlatform;
  permission: () => Promise<AlertPermission>;
  /** Shows the system prompt; only called after the person taps to turn alerts on. */
  request: () => Promise<AlertPermission>;
  /** The Expo push token, or null when it cannot be read (no push capability, offline, simulator). */
  token: () => Promise<string | null>;
  transport: (actor: string) => OwnerHttpTransport;
};
export type PushState =
  | { permission: Exclude<AlertPermission, 'granted'>; status: 'off' }
  | { permission: 'granted'; status: 'registered' }
  | { permission: 'granted'; status: 'failed'; failure: PushFailure | null }
  /** Signing out of this account: registration waits until sign-out finishes or is cancelled. */
  | { permission: AlertPermission; status: 'paused' };

/**
 * Remembers which account and token this app run already registered, so returning to the
 * foreground does not re-send it. A new account, a new backend or a token change registers again.
 * A held account is not registered at all while it signs out (T45).
 */
export function createRegistrationMemo() {
  const done = new Map<string, string>();
  const holds = new Set<string>();
  const inflight = new Map<string, Promise<void>>();
  const key = (backend: string, actor: string) => `${backend}|${actor}`;
  return {
    get: (backend: string, actor: string) => done.get(key(backend, actor)) ?? null,
    set: (backend: string, actor: string, token: string) => { done.set(key(backend, actor), token); },
    forget: (backend: string, actor: string) => { done.delete(key(backend, actor)); },
    /** Token changes forget every registration; holds stay. */
    clear: () => done.clear(),
    hold: (backend: string, actor: string) => { holds.add(key(backend, actor)); },
    unhold: (backend: string, actor: string) => { holds.delete(key(backend, actor)); },
    held: (backend: string, actor: string) => holds.has(key(backend, actor)),
    /** Records a registration request that is on its way, so a sign-out can wait for it to land. */
    track: (backend: string, actor: string, request: Promise<unknown>) => {
      const k = key(backend, actor);
      const settled = request.then(() => undefined, () => undefined);
      inflight.set(k, settled);
      void settled.then(() => { if (inflight.get(k) === settled) inflight.delete(k); });
    },
    settled: (backend: string, actor: string): Promise<void> => inflight.get(key(backend, actor)) ?? Promise.resolve(),
  };
}
export type RegistrationMemo = ReturnType<typeof createRegistrationMemo>;

/** Registers this phone for `actor` when alerts are allowed. `ask` shows the system prompt if it has not been answered. */
export async function syncPushRegistration(ports: PushPorts, memo: RegistrationMemo, actor: string, ask: boolean): Promise<PushState> {
  if (memo.held(ports.backend, actor)) return { permission: await ports.permission(), status: 'paused' };
  let permission = await ports.permission();
  if (permission === 'undetermined' && ask) permission = await ports.request();
  if (permission !== 'granted') return { permission, status: 'off' };
  if (memo.get(ports.backend, actor)) return { permission, status: 'registered' };
  const token = await ports.token();
  if (!token) return { permission, status: 'failed', failure: null };
  // Checked again right before sending: a sign-out that began meanwhile must not be undone. From here
  // the request is tracked synchronously, so the sign-out waits for it and then removes it.
  if (memo.held(ports.backend, actor)) return { permission, status: 'paused' };
  const request = registerPushDevice(ports.transport(actor), token, ports.platform);
  memo.track(ports.backend, actor, request);
  const outcome = await request;
  if (!outcome.ok) return { permission, status: 'failed', failure: outcome.failure };
  memo.set(ports.backend, actor, token);
  return memo.held(ports.backend, actor) ? { permission, status: 'paused' } : { permission, status: 'registered' };
}

export type ReleaseOutcome = { status: 'released' | 'none' } | { status: 'failed'; failure: PushFailure | null };

/**
 * Sign-out, step one (T45): holds registration for `actor`, then removes this phone's token from that
 * account while its session still exists. `none` means this phone has nothing to remove (alerts never
 * allowed here, or this build has no push). The caller ends the hold with `memo.unhold` once sign-out
 * finishes or is abandoned; a failure leaves the account's registration as it was.
 */
export async function releasePushRegistration(ports: PushPorts, memo: RegistrationMemo, actor: string): Promise<ReleaseOutcome> {
  memo.hold(ports.backend, actor);
  await memo.settled(ports.backend, actor);
  let token = memo.get(ports.backend, actor);
  if (!token) {
    // Without permission iOS shows nothing, and the token moves at the next sign-in anyway.
    if (await ports.permission() !== 'granted') return { status: 'none' };
    token = await ports.token();
    if (!token) return { status: 'failed', failure: null };
  }
  const outcome = await unregisterPushDevice(ports.transport(actor), token);
  if (!outcome.ok) return { status: 'failed', failure: outcome.failure };
  memo.forget(ports.backend, actor);
  return { status: 'released' };
}

/**
 * The booking-screen nudge appears only while iOS has never been asked and the person has not said
 * "Not now" on this phone (`dismissed` null = still reading). Denied, unavailable and on stay quiet:
 * booking never depends on alerts.
 */
export function showAlertsNudge(permission: AlertPermission | null, dismissed: boolean | null): boolean {
  return dismissed === false && permission === 'undetermined';
}

/** What each switch on the Booking alerts screen covers. */
export const TOPIC_COPY: Record<NotificationTopic, { title: string; detail: string }> = {
  updates: { title: 'Booking updates', detail: 'When a venue confirms or declines your request, a request expires, or a venue cancels' },
  reminders: { title: 'Reminders', detail: 'About an hour before your court time or open play starts' },
  payments: { title: 'Payment records', detail: 'When a venue records the payment you made there' },
  requests: { title: 'Booking requests', detail: 'When a player asks to book one of your venues and needs your answer' },
  bookings: { title: 'New bookings and cancellations', detail: 'When a player books one of your venues outright, or cancels' },
};

export function preferencesFailureMessage(failure: PushFailure): string {
  if (failure.kind === 'rate_limited') return `Too many changes just now. Try again in ${failure.retryAfterSeconds} seconds.`;
  if (failure.kind === 'sign_in') return 'Sign in again to change your alerts.';
  if (failure.kind === 'rejected' && failure.reason === 'account_deleted') return 'This account is being deleted, so its alerts can’t change.';
  return 'Couldn’t reach pickly, so your alerts didn’t change. Try again.';
}

/** Why sign-out could not turn alerts off, for the "sign out anyway?" question. */
export function releaseFailureMessage(failure: PushFailure | null): string {
  const tail = 'You can try again, or sign out anyway: this phone may keep showing booking alerts for this account until someone signs in here again.';
  if (failure?.kind === 'rate_limited') return `Too many tries just now. Wait ${failure.retryAfterSeconds} seconds. ${tail}`;
  if (failure?.kind === 'network') return `You seem to be offline. ${tail}`;
  return `pickly couldn’t confirm it right now. ${tail}`;
}

/** Subtitle for the Account **Booking alerts** row. */
export function bookingAlertsLabel(state: PushState | null): string {
  if (!state) return 'Checking…';
  if (state.status === 'paused') return 'Turning off while you sign out…';
  if (state.status === 'registered') return 'On for this phone · choose which alerts';
  if (state.status === 'failed') {
    if (state.failure?.kind === 'rate_limited') return `Couldn’t turn on · try again in ${state.failure.retryAfterSeconds} seconds`;
    if (state.failure?.kind === 'sign_in') return 'Couldn’t turn on · sign in again, then try again';
    return state.failure ? 'Couldn’t turn on · tap to try again' : 'Not available on this phone yet · tap to try again';
  }
  switch (state.permission) {
    case 'undetermined': return 'Off · tap to get booking updates on this phone';
    case 'denied': return 'Off · open Settings to allow notifications';
    case 'unavailable': return 'Not available in this version of the app';
  }
}
