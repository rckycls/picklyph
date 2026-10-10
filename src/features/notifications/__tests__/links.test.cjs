const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');

const root = path.resolve(path.dirname(module.filename), '../../../..');
const domain = { ...require(path.join(root, 'packages/domain/src/booking.ts')), ...require(path.join(root, 'packages/domain/src/notification.ts')) };
const links = load(path.join(root, 'src/features/notifications/links.ts'), { '@picklyph/domain': domain });

const me = 'c4380000-0000-4000-8000-000000000001';
const someoneElse = 'c4380000-0000-4000-8000-000000000002';
const booking = 'c4380000-0000-4000-8000-0000000000b1';
const venue = 'c4380000-0000-4000-8000-0000000000f1';
const plain = (value) => JSON.parse(JSON.stringify(value));
const data = (patch = {}) => ({ notification_id: 'c4380000-0000-4000-8000-0000000000a1', kind: 'booking.reminder', audience: 'player', booking_kind: 'rental',
  booking_id: booking, venue_id: venue, starts_at: '2026-10-12T17:00:00Z', recipient: me, ...patch });
const pending = (patch = {}, at = 1000) => { const store = links.createLinkStore(); store.offer(data(patch), at); return store.get(); };
const ready = { status: 'ready', user: me };
const checked = { count: 2, error: false };

test('targets: players open their booking; owners open requests, or the front desk on the booking’s Manila day', () => {
  assert.deepEqual(plain(links.linkTarget(domain.readPushData(data()))), { owner: false, target: { pathname: '/rental/booking/[id]', params: { id: booking } } });
  assert.deepEqual(plain(links.linkTarget(domain.readPushData(data({ booking_kind: 'group', kind: 'booking.accepted' })))).target,
    { pathname: '/play/booking/[id]', params: { id: booking } });
  assert.deepEqual(plain(links.linkTarget(domain.readPushData(data({ audience: 'owner', kind: 'booking.requested' })))),
    { owner: true, target: { pathname: '/owner/requests/[id]', params: { id: venue } } });
  // 17:00 UTC is 01:00 the next day in Manila.
  for (const kind of ['booking.created', 'booking.cancelled']) {
    assert.deepEqual(plain(links.linkTarget(domain.readPushData(data({ audience: 'owner', kind, booking_kind: 'group' })))),
      { owner: true, target: { pathname: '/owner/desk/[id]', params: { id: venue, date: '2026-10-13' } } }, kind);
  }
});

test('a link opens only for the account it was sent to, waits for sign-in restore and venue checks, and expires', () => {
  const link = pending();
  assert.deepEqual(plain(links.nextLinkStep(link, ready, checked, 2000)), { kind: 'open', target: plain(link.target), owner: false });
  assert.equal(links.nextLinkStep(link, { status: 'ready', user: me.toUpperCase() }, checked, 2000).kind, 'open');
  assert.equal(links.nextLinkStep(link, { status: 'restoring', user: null }, checked, 2000).kind, 'wait');
  assert.equal(links.nextLinkStep(link, { status: 'ready', user: null }, checked, 2000).kind, 'sign_in');
  assert.equal(links.nextLinkStep(link, { status: 'error', user: null }, checked, 2000).kind, 'sign_in');
  assert.equal(links.nextLinkStep(link, { status: 'ready', user: someoneElse }, checked, 2000).kind, 'other_account');
  // Player links ignore the owner venue check.
  assert.equal(links.nextLinkStep(link, ready, { count: null, error: true }, 2000).kind, 'open');
  assert.equal(links.nextLinkStep(link, { status: 'ready', user: null }, checked, 1000 + links.LINK_LIFETIME_MS).kind, 'sign_in');
  assert.equal(links.nextLinkStep(link, { status: 'ready', user: null }, checked, 1001 + links.LINK_LIFETIME_MS).kind, 'expired');
  assert.equal(links.nextLinkStep(link, ready, checked, 1001 + links.LINK_LIFETIME_MS).kind, 'expired', 'an old link never opens later');

  const owner = pending({ audience: 'owner', kind: 'booking.requested' });
  assert.equal(links.nextLinkStep(owner, ready, { count: null, error: false }, 2000).kind, 'wait');
  assert.equal(links.nextLinkStep(owner, ready, { count: null, error: true }, 2000).kind, 'access_unknown');
  assert.equal(links.nextLinkStep(owner, ready, { count: 0, error: false }, 2000).kind, 'no_venue');
  assert.deepEqual(plain(links.nextLinkStep(owner, ready, checked, 2000)), { kind: 'open', target: plain(owner.target), owner: true });
  assert.equal(links.nextLinkStep(owner, { status: 'ready', user: someoneElse }, checked, 2000).kind, 'other_account', 'another owner never opens it');
});

test('notices explain every link that does not open', () => {
  assert.equal(links.linkNotice({ kind: 'other_account' }).title, 'This alert is for another account');
  assert.equal(links.linkNotice({ kind: 'sign_in' }).title, 'Sign in to open this alert');
  assert.equal(links.linkNotice({ kind: 'no_venue' }).body, 'This account no longer manages that venue.');
  assert.ok(links.linkNotice({ kind: 'access_unknown' }).title);
  for (const kind of ['wait', 'expired', 'open']) assert.equal(links.linkNotice({ kind }), null, kind);
});

test('the store takes each valid notification once and keeps one pending link', () => {
  const store = links.createLinkStore(); let changes = 0;
  const stop = store.subscribe(() => { changes++; });
  for (const bad of [null, {}, data({ recipient: 'x' }), data({ audience: 'owner' }), { url: 'picklyph://owner/venues' }]) assert.equal(store.offer(bad, 1), false);
  assert.equal(store.get(), null);
  assert.equal(store.offer(data(), 1), true);
  const first = store.get(); assert.equal(first.data.booking_id, booking); assert.equal(first.prompted, false);
  assert.equal(store.offer(data(), 2), false, 'the launch response and the listener report the same tap once');
  store.markPrompted(first); assert.equal(store.get().prompted, true);
  store.finish(first); assert.notEqual(store.get(), null, 'finishing a replaced link changes nothing');
  store.finish(store.get()); assert.equal(store.get(), null);
  assert.equal(store.offer(data({ notification_id: 'c4380000-0000-4000-8000-0000000000a2' }), 3), true, 'a new notification replaces it');
  stop(); assert.equal(changes, 4);
});
