import { readPushDeviceCommand, type PushDeviceResult, type PushPlatform } from '@picklyph/domain';

import { ownerRequest, type HttpFailure, type HttpOutcome, type OwnerHttpTransport } from '../owner/venueClient';

// Pure client and registration logic for the push-devices Edge function (T43), so Node tests drive them
// against the real handler. Expo and permission calls come in through `PushPorts` (see pushLive.ts).
export const PUSH_REJECTIONS = ['invalid_request', 'account_deleted'] as const;
export type PushFailure = HttpFailure<typeof PUSH_REJECTIONS[number]>;
export type PushOutcome = HttpOutcome<PushDeviceResult, typeof PUSH_REJECTIONS[number]>;

function send(transport: OwnerHttpTransport, body: unknown, expected: PushDeviceResult['status']): Promise<PushOutcome> {
  return ownerRequest(transport, transport.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    (raw) => {
      if (raw.status !== expected || Object.keys(raw).length !== 1) throw new Error('Unexpected push device response.');
      return { status: expected };
    }, PUSH_REJECTIONS);
}

/** Retry-safe: registering the same token again changes nothing. */
export function registerPushDevice(transport: OwnerHttpTransport, token: string, platform: PushPlatform): Promise<PushOutcome> {
  return send(transport, readPushDeviceCommand({ kind: 'register', token, platform }), 'registered');
}

/** Removes the token from the signed-in account only. Sign-out wiring is T45. */
export function unregisterPushDevice(transport: OwnerHttpTransport, token: string): Promise<PushOutcome> {
  return send(transport, readPushDeviceCommand({ kind: 'unregister', token }), 'removed');
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
  | { permission: 'granted'; status: 'failed'; failure: PushFailure | null };

/**
 * Remembers which account and token this app run already registered, so returning to the
 * foreground does not re-send it. A new account, a new backend or a token change registers again.
 */
export function createRegistrationMemo() {
  const done = new Map<string, string>();
  const key = (backend: string, actor: string) => `${backend}|${actor}`;
  return {
    get: (backend: string, actor: string) => done.get(key(backend, actor)) ?? null,
    set: (backend: string, actor: string, token: string) => { done.set(key(backend, actor), token); },
    clear: () => done.clear(),
  };
}
export type RegistrationMemo = ReturnType<typeof createRegistrationMemo>;

/** Registers this phone for `actor` when alerts are allowed. `ask` shows the system prompt if it has not been answered. */
export async function syncPushRegistration(ports: PushPorts, memo: RegistrationMemo, actor: string, ask: boolean): Promise<PushState> {
  let permission = await ports.permission();
  if (permission === 'undetermined' && ask) permission = await ports.request();
  if (permission !== 'granted') return { permission, status: 'off' };
  if (memo.get(ports.backend, actor)) return { permission, status: 'registered' };
  const token = await ports.token();
  if (!token) return { permission, status: 'failed', failure: null };
  const outcome = await registerPushDevice(ports.transport(actor), token, ports.platform);
  if (!outcome.ok) return { permission, status: 'failed', failure: outcome.failure };
  memo.set(ports.backend, actor, token);
  return { permission, status: 'registered' };
}

/** Subtitle for the Account **Booking alerts** row. */
export function bookingAlertsLabel(state: PushState | null): string {
  if (!state) return 'Checking…';
  if (state.status === 'registered') return 'On · requests, confirmations and cancellations';
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
