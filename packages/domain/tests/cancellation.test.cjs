const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CANCELLATION_REASONS, CANCELLATION_REASON_LABELS, readVenueCancel, playerCancellationReason, isCancellationReason } = require('../src/cancellation.ts');
const { readRentalCommand } = require('../src/rentalBooking.ts');
const { readSessionBookingCommand } = require('../src/sessionBooking.ts');
const { readSessionCommand } = require('../src/session.ts');
const { readNotificationPayload, notificationMessage } = require('../src/notification.ts');

const id = 'CA000000-0000-4000-8000-000000000001'; const lower = id.toLowerCase();
const payload = (patch = {}) => ({ audience: 'player', booking_kind: 'rental', booking_id: lower, venue_id: lower,
  venue_name: 'Court Club', starts_at: '2026-10-12T10:00:00Z', ...patch });

test('venue cancellations: one fixed reason, a booking and nothing else; both booking endpoints accept them', () => {
  assert.deepEqual([...CANCELLATION_REASONS], ['weather', 'maintenance', 'venue_closed', 'schedule_conflict', 'player_request', 'other']);
  for (const reason of CANCELLATION_REASONS) {
    assert.ok(CANCELLATION_REASON_LABELS[reason].length > 0);
    assert.deepEqual(readVenueCancel({ kind: 'venue_cancel', booking_id: id, reason }), { kind: 'venue_cancel', booking_id: lower, reason });
  }
  for (const bad of [null, [], {}, { kind: 'venue_cancel', booking_id: id }, { kind: 'venue_cancel', booking_id: id, reason: 'rain' },
    { kind: 'venue_cancel', booking_id: 'x', reason: 'weather' }, { kind: 'cancel', booking_id: id, reason: 'weather' },
    { kind: 'venue_cancel', booking_id: id, reason: 'weather', actor_user_id: id }, { kind: 'venue_cancel', booking_id: id, reason: 'weather', refund: true }]) {
    assert.throws(() => readVenueCancel(bad), JSON.stringify(bad));
  }
  const body = { kind: 'venue_cancel', booking_id: id, reason: 'maintenance' };
  assert.deepEqual(readRentalCommand(body), { ...body, booking_id: lower });
  assert.deepEqual(readSessionBookingCommand(body), { ...body, booking_id: lower });
  assert.throws(() => readRentalCommand({ ...body, reason: 'refund' }));
  assert.throws(() => readSessionBookingCommand({ ...body, venue_id: id }));
  assert.ok(isCancellationReason('weather')); assert.ok(!isCancellationReason('Weather')); assert.ok(!isCancellationReason(null));
});

test('session cancellation takes an optional reason, which the server requires once anyone holds a spot', () => {
  assert.deepEqual(readSessionCommand({ kind: 'cancel', session_id: id }), { kind: 'cancel', session_id: lower, reason: null });
  assert.deepEqual(readSessionCommand({ kind: 'cancel', session_id: id, reason: 'weather' }), { kind: 'cancel', session_id: lower, reason: 'weather' });
  for (const bad of [{ kind: 'cancel', session_id: id, reason: null }, { kind: 'cancel', session_id: id, reason: 'rain' },
    { kind: 'cancel', session_id: id, reason: 'weather', notify: false }, { kind: 'cancel', reason: 'weather' }]) assert.throws(() => readSessionCommand(bad), JSON.stringify(bad));
});

test('a player alert names the reason; owners never get one with a reason', () => {
  assert.equal(readNotificationPayload(payload({ reason: 'weather' })).reason, 'weather');
  assert.equal('reason' in readNotificationPayload(payload()), false);
  for (const bad of [payload({ reason: 'rain' }), payload({ reason: null }), payload({ audience: 'owner', reason: 'weather' })]) {
    assert.throws(() => readNotificationPayload(bad), JSON.stringify(bad));
  }
  const text = (reason, kind = 'rental') => notificationMessage('booking.cancelled', readNotificationPayload(payload({ booking_kind: kind, ...(reason ? { reason } : {}) }))).body;
  assert.match(text('weather'), /^Court Club cancelled your court rental for .+ because of the weather\.$/);
  assert.match(text('player_request', 'group'), /^Court Club cancelled your open-play group for .+ at your request\.$/);
  assert.match(text('other'), /^Court Club cancelled your court rental for [^.]+\.$/);
  assert.equal(text('other'), text(null));
  for (const reason of CANCELLATION_REASONS) assert.equal(playerCancellationReason(reason) === null, reason === 'other');
});
