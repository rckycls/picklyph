import { formatManilaDateTime } from './booking.ts';
import { formatPhpCentavos, isPhpCentavos } from './money.ts';

/** T43 push notifications: the push-devices body, outbox kinds and message text. See docs/notifications.md. */
export const MAX_PUSH_DEVICE_BYTES = 1024;
/** Devices kept per account; registering another evicts the least recently seen. */
export const MAX_PUSH_DEVICES = 10;
/** Expo push tokens: `ExponentPushToken[…]` or `ExpoPushToken[…]`, printable ASCII without brackets or backslash inside. */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[!-Z^-~]{1,200}\]$/;
export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export type PushPlatform = typeof PUSH_PLATFORMS[number];

/** Never carries an account: the server registers the verified caller's own device. */
export type PushDeviceRegister = { kind: 'register'; token: string; platform: PushPlatform };
export type PushDeviceUnregister = { kind: 'unregister'; token: string };
export type PushDeviceCommand = PushDeviceRegister | PushDeviceUnregister;
export type PushDeviceResult = { status: 'registered' | 'removed' };

export const NOTIFICATION_KINDS = ['booking.requested', 'booking.created', 'booking.accepted', 'booking.declined',
  'booking.expired', 'booking.cancelled', 'payment.recorded'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type NotificationAudience = 'owner' | 'player';
/** What the outbox stores for a row: booking facts at event time, no names or contact details. */
export type NotificationPayload = {
  audience: NotificationAudience;
  booking_kind: 'rental' | 'group';
  booking_id: string;
  venue_id: string;
  venue_name: string;
  starts_at: string;
  amount_centavos?: number;
};
/** The data each push carries, for the app to route to the authoritative booking screen (T44). */
export type PushData = { notification_id: string; kind: NotificationKind; audience: NotificationAudience; booking_kind: 'rental' | 'group'; booking_id: string };

/** Worker contract with the service-only outbox commands (`push_outbox_claim|complete`, `push_receipts_due|record`). */
export type PushClaimDevice = { id: string; token: string };
export type PushClaimItem = { id: string; claim_id: string; kind: NotificationKind; payload: unknown; devices: PushClaimDevice[] };
export type PushClaim = { items: PushClaimItem[]; more: boolean };
export type PushDeliveryOutcome =
  | { device_id: string; outcome: 'ok'; ticket_id: string | null }
  | { device_id: string; outcome: 'invalid' | 'retry' }
  | { device_id: string; outcome: 'error'; error: string };
export type PushCompletion = { id: string; claim_id: string; deliveries: PushDeliveryOutcome[]; retry_after_seconds?: number };
export type PushReceiptOutcome = { ticket_id: string; outcome: 'ok' | 'invalid' } | { ticket_id: string; outcome: 'error'; error: string };

export class NotificationInputError extends Error {
  constructor(message = 'Invalid push device request.') { super(message); this.name = 'NotificationInputError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new NotificationInputError();
  return raw as Record<string, unknown>;
};
const keys = (input: Record<string, unknown>) => Object.keys(input).sort().join(',');

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && EXPO_PUSH_TOKEN.test(value);
}

/** Strict body: `{kind:'register', token, platform}` or `{kind:'unregister', token}` and nothing else. */
export function readPushDeviceCommand(raw: unknown): PushDeviceCommand {
  const input = record(raw);
  if (input.kind === 'register' && keys(input) === 'kind,platform,token' && isExpoPushToken(input.token)
    && (PUSH_PLATFORMS as readonly unknown[]).includes(input.platform)) {
    return { kind: 'register', token: input.token, platform: input.platform as PushPlatform };
  }
  if (input.kind === 'unregister' && keys(input) === 'kind,token' && isExpoPushToken(input.token)) {
    return { kind: 'unregister', token: input.token };
  }
  throw new NotificationInputError();
}

/** Strict outbox payload, so the worker never sends text built from an unexpected row. */
export function readNotificationPayload(raw: unknown): NotificationPayload {
  const input = record(raw);
  const payment = 'amount_centavos' in input;
  if (keys(input) !== (payment ? 'amount_centavos,audience,booking_id,booking_kind,starts_at,venue_id,venue_name' : 'audience,booking_id,booking_kind,starts_at,venue_id,venue_name')
    || (input.audience !== 'owner' && input.audience !== 'player') || (input.booking_kind !== 'rental' && input.booking_kind !== 'group')
    || typeof input.booking_id !== 'string' || !UUID.test(input.booking_id) || typeof input.venue_id !== 'string' || !UUID.test(input.venue_id)
    || typeof input.venue_name !== 'string' || input.venue_name.trim().length === 0 || input.venue_name.length > 120
    || typeof input.starts_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(input.starts_at) || Number.isNaN(Date.parse(input.starts_at))
    || (payment && !isPhpCentavos(input.amount_centavos))) {
    throw new NotificationInputError('Invalid notification payload.');
  }
  return { audience: input.audience, booking_kind: input.booking_kind, booking_id: input.booking_id.toLowerCase(), venue_id: input.venue_id.toLowerCase(),
    venue_name: input.venue_name.trim(), starts_at: input.starts_at, ...(payment ? { amount_centavos: input.amount_centavos as number } : {}) };
}

export function isNotificationKind(value: unknown): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly unknown[]).includes(value);
}

/**
 * Lock-screen text. Short, factual, no participant names; the booking screen stays the source of truth.
 * Throws for a kind/audience pair the outbox never writes.
 */
export function notificationMessage(kind: NotificationKind, payload: NotificationPayload): { title: string; body: string } {
  const when = formatManilaDateTime(payload.starts_at);
  const venue = payload.venue_name;
  const rental = payload.booking_kind === 'rental';
  const owner = payload.audience === 'owner';
  const what = rental ? 'court rental' : 'open-play group';
  if (owner) {
    switch (kind) {
      case 'booking.requested': return { title: 'New booking request', body: rental
        ? `A player asked to rent a court at ${venue} for ${when}. Accept or decline in Booking requests.`
        : `A group asked to join open play at ${venue} on ${when}. Accept or decline in Booking requests.` };
      case 'booking.created': return { title: 'New booking', body: rental
        ? `A player booked a court at ${venue} for ${when}.` : `A group joined open play at ${venue} on ${when}.` };
      case 'booking.cancelled': return { title: 'Booking cancelled', body: `A player cancelled their ${what} at ${venue} for ${when}.` };
      default: break;
    }
  } else {
    switch (kind) {
      case 'booking.accepted': return { title: 'Booking confirmed', body: `${venue} confirmed your ${what} for ${when}.` };
      case 'booking.declined': return { title: 'Request declined', body: `${venue} declined your ${what} request for ${when}.` };
      case 'booking.expired': return { title: 'Request expired', body: `${venue} didn’t answer your ${what} request for ${when} in time, so it was released.` };
      case 'booking.cancelled': return { title: 'Booking cancelled', body: `${venue} cancelled your ${what} for ${when}.` };
      case 'payment.recorded': {
        if (payload.amount_centavos === undefined) break;
        return { title: 'Payment recorded', body: `${venue} recorded your ${formatPhpCentavos(payload.amount_centavos)} payment for your ${what} on ${when}.` };
      }
      default: break;
    }
  }
  throw new NotificationInputError('Unexpected notification.');
}
