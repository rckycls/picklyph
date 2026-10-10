const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readPushDeviceCommand, readNotificationPayload, notificationMessage, isExpoPushToken, NotificationInputError, NOTIFICATION_KINDS } = require('../src/notification.ts');

const token = 'ExponentPushToken[xXyZ09_-]';
const payload = (patch = {}) => ({ audience: 'player', booking_kind: 'rental', booking_id: 'C4320000-0000-4000-8000-000000000001',
  venue_id: 'c4330000-0000-4000-8000-000000000001', venue_name: ' Court Club ', starts_at: '2026-10-12T10:00:00Z', ...patch });

test('Expo push tokens: both prefixes, printable ASCII inside, no brackets, spaces or backslashes', () => {
  for (const ok of [token, 'ExpoPushToken[abc]', 'ExponentPushToken[a:b.c+d/e=f]', `ExponentPushToken[${'a'.repeat(200)}]`]) assert.ok(isExpoPushToken(ok), ok);
  for (const bad of ['ExponentPushToken[]', 'ExponentPushToken[a b]', 'ExponentPushToken[a]]', 'ExponentPushToken[a\\b]', 'ExponentPushToken[é]',
    `ExponentPushToken[${'a'.repeat(201)}]`, 'exponentpushtoken[a]', 'ExponentPushToken[a', 'fcm-token', 7, null]) assert.ok(!isExpoPushToken(bad), String(bad));
});

test('push-devices bodies are strict and never carry an account', () => {
  assert.deepEqual(readPushDeviceCommand({ kind: 'register', token, platform: 'ios' }), { kind: 'register', token, platform: 'ios' });
  assert.deepEqual(readPushDeviceCommand({ platform: 'android', token, kind: 'register' }), { kind: 'register', token, platform: 'android' });
  assert.deepEqual(readPushDeviceCommand({ kind: 'unregister', token }), { kind: 'unregister', token });
  for (const bad of [{}, null, [], 'x', { kind: 'register', token }, { kind: 'register', token, platform: 'web' }, { kind: 'register', token, platform: 'ios', user_id: 'x' },
    { kind: 'unregister', token, platform: 'ios' }, { kind: 'unregister' }, { kind: 'register', token: 'abc', platform: 'ios' }, { kind: 'remove', token }]) {
    assert.throws(() => readPushDeviceCommand(bad), NotificationInputError, JSON.stringify(bad));
  }
});

test('outbox payloads are parsed strictly', () => {
  assert.deepEqual(readNotificationPayload(payload()), { ...payload(), booking_id: payload().booking_id.toLowerCase(), venue_name: 'Court Club' });
  assert.equal(readNotificationPayload(payload({ amount_centavos: 60000 })).amount_centavos, 60000);
  for (const bad of [payload({ audience: 'admin' }), payload({ booking_kind: 'session' }), payload({ booking_id: 'x' }), payload({ venue_name: ' ' }),
    payload({ venue_name: 'x'.repeat(121) }), payload({ starts_at: '2026-10-12 10:00' }), payload({ starts_at: '2026-13-40T10:00:00Z' }),
    payload({ amount_centavos: -1 }), payload({ amount_centavos: 1.5 }), payload({ extra: 1 }), null, []]) {
    assert.throws(() => readNotificationPayload(bad), NotificationInputError, JSON.stringify(bad));
  }
});

test('lock-screen text: Manila time, venue name, no participant names; owner and player wording differ', () => {
  const at = /Oct 12, 2026, 6:00\sPM/u;
  const owner = (kind, booking_kind = 'rental') => notificationMessage(kind, readNotificationPayload(payload({ audience: 'owner', booking_kind })));
  const player = (kind, booking_kind = 'rental', extra = {}) => notificationMessage(kind, readNotificationPayload(payload({ booking_kind, ...extra })));
  assert.equal(owner('booking.requested').title, 'New booking request');
  assert.match(owner('booking.requested').body, /^A player asked to rent a court at Court Club for .+\. Accept or decline in Booking requests\.$/);
  assert.match(owner('booking.requested', 'group').body, /^A group asked to join open play at Court Club on /);
  assert.match(owner('booking.created').body, /^A player booked a court at Court Club for /);
  assert.match(owner('booking.cancelled', 'group').body, /^A player cancelled their open-play group at Court Club for /);
  assert.deepEqual(player('booking.accepted').title, 'Booking confirmed');
  assert.match(player('booking.accepted').body, at);
  assert.match(player('booking.declined', 'group').body, /^Court Club declined your open-play group request for /);
  assert.match(player('booking.expired').body, /^Court Club didn’t answer your court rental request for .+ in time, so it was released\.$/);
  assert.match(player('booking.cancelled').body, /^Court Club cancelled your court rental for /);
  assert.match(player('payment.recorded', 'rental', { amount_centavos: 123456 }).body, /^Court Club recorded your ₱1,234\.56 payment for your court rental on /);
  // Pairs the outbox never writes are refused rather than worded wrongly.
  for (const kind of ['booking.accepted', 'booking.declined', 'booking.expired', 'payment.recorded']) assert.throws(() => owner(kind), NotificationInputError, kind);
  for (const kind of ['booking.requested', 'booking.created']) assert.throws(() => player(kind), NotificationInputError, kind);
  assert.throws(() => player('payment.recorded'), NotificationInputError, 'payment needs an amount');
  assert.equal(NOTIFICATION_KINDS.length, 7);
});
