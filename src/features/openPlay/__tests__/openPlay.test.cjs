const assert = require('node:assert/strict');
const { test } = require('node:test');
const { client, model, createGroupJournal, rentalModel, plain, memory } = require('./helpers.cjs');

const VENUE = 'a3000000-0000-4000-8000-000000000001'; const COURT = 'b3000000-0000-4000-8000-000000000001';
const SESSION = 'c3000000-0000-4000-8000-000000000001'; const BOOKING = 'd3000000-0000-4000-8000-000000000001';
const REQUEST = 'e3000000-0000-4000-8000-000000000001';
const AT = '2026-10-09T01:00:00.123456+00:00';
const offer = (delta = {}, snap = {}) => ({ id: SESSION, venue_id: VENUE, status: 'scheduled', available_spots: 5, ...delta,
  snapshot: { court_ids: [COURT], title: 'Evening open play', starts_at: '2026-10-10T10:00:00+00:00', ends_at: '2026-10-10T12:00:00+00:00',
    capacity: 8, group_limit: 4, price_centavos: 25000, currency: 'PHP', timezone: 'Asia/Manila',
    policy: { confirmation: 'instant', payment: 'arrival', merchant_active: false }, approval_hold_minutes: 120, payment_hold_minutes: 15, refund_cutoff_hours: 24, ...snap } });
const booking = (delta = {}) => ({ id: BOOKING, session_id: SESSION, source: 'player', status: 'confirmed', payment_method: 'arrival', payment_status: 'unpaid', operations: { attendance: 'none', attendance_at: null, payment: null },
  participants: ['Ana', 'Ben'], spots: 2, expires_at: null, created_at: AT, updated_at: AT,
  snapshot: { venue_id: VENUE, title: 'Evening open play', court_ids: [COURT], starts_at: '2026-10-10T10:00:00+00:00', ends_at: '2026-10-10T12:00:00+00:00',
    price_centavos: 25000, spots: 2, total_centavos: 50000, currency: 'PHP', timezone: 'Asia/Manila',
    policy: { confirmation: 'instant', payment: 'arrival', merchant_active: false }, policy_revision: '0', approval_hold_minutes: 120, payment_hold_minutes: 15, refund_cutoff_hours: 24 }, ...delta });
const response = (body, status = 200, headers = {}) => {
  const r = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  // Expo's native FetchResponse does not inherit global Response.
  return { ok: r.ok, status: r.status, headers: r.headers, json: () => r.json() };
};
const transport = (reply, seen = {}) => ({ endpoint: 'https://groups.test/functions/v1/session-bookings', apiKey: 'public-fixture', accessToken: async () => 'fixture-token',
  fetch: async (url, init) => { seen.url = new URL(url); seen.init = init; seen.body = init.body ? JSON.parse(init.body) : null; return typeof reply === 'function' ? reply(seen) : reply; } });
const parsed = model.groupRequest(client.parseOffer(offer()), ['Ana', 'Ben'], REQUEST);

test('session offers are strict: spots, limits, courts, money, policy, clock fields and status must agree', () => {
  const o = client.parseOffer(offer());
  assert.equal(o.snapshot.starts_at, '2026-10-10T10:00:00.000Z'); assert.equal(o.available_spots, 5); assert.equal(o.snapshot.price_centavos, 25000);
  assert.equal(client.parseOffer(offer({ status: 'cancelled', available_spots: 0 })).status, 'cancelled');
  assert.equal(client.parseOffer(offer({}, { policy: { confirmation: 'approval', payment: 'online', merchant_active: true } })).snapshot.policy.payment, 'online');
  for (const [delta, snap] of [[{ status: 'cancelled' }], [{ available_spots: 9 }], [{ available_spots: -1 }], [{ available_spots: 1.5 }], [{ status: 'open' }], [{ id: 'nope' }],
    [{}, { group_limit: 9 }], [{}, { capacity: 201, group_limit: 4 }], [{}, { court_ids: [COURT, COURT] }], [{}, { court_ids: [] }], [{}, { currency: 'USD' }],
    [{}, { timezone: 'UTC' }], [{}, { price_centavos: 1.5 }], [{}, { price_centavos: -1 }], [{}, { ends_at: '2026-10-10T10:00:00+00:00' }],
    [{}, { starts_at: '2026-10-10 10:00' }], [{}, { title: ' ' }], [{}, { refund_cutoff_hours: 12 }], [{}, { approval_hold_minutes: 60 }],
    [{}, { policy: { confirmation: 'instant', payment: 'online', merchant_active: false } }], [{}, { policy: { confirmation: 'auto', payment: 'arrival', merchant_active: false } }]])
    assert.throws(() => client.parseOffer(offer(delta, snap)), undefined, JSON.stringify([delta, snap]));
});

test('session pages keep server order, venue, scheduled status and cursor rules; single reads match the requested session', async () => {
  const seen = {}; const second = offer({ id: 'c3000000-0000-4000-8000-000000000002' });
  let page = await client.loadOffers(transport(response({ venue_id: VENUE, at: AT, sessions: [offer(), second], next_cursor: null }), seen), VENUE, null);
  assert.equal(page.ok, true); assert.equal(page.value.at, '2026-10-09T01:00:00.123Z'); assert.equal(page.value.sessions.length, 2);
  assert.deepEqual(Object.fromEntries(seen.url.searchParams), { section: 'sessions', venue_id: VENUE }); assert.equal(seen.init.method, 'GET');
  await client.loadOffers(transport(response({ venue_id: VENUE, at: AT, sessions: [second], next_cursor: null }), seen), VENUE, SESSION);
  assert.equal(seen.url.searchParams.get('after_id'), SESSION);
  const later = offer({ id: 'c3000000-0000-4000-8000-000000000000' }, { starts_at: '2026-10-10T11:00:00+00:00' });
  for (const body of [{ venue_id: VENUE, at: AT, sessions: [second, offer()], next_cursor: null }, { venue_id: VENUE, at: AT, sessions: [later, offer()], next_cursor: null },
    { venue_id: VENUE, at: AT, sessions: [offer({ venue_id: COURT })], next_cursor: null }, { venue_id: COURT, at: AT, sessions: [], next_cursor: null },
    { venue_id: VENUE, at: AT, sessions: [offer({ status: 'cancelled', available_spots: 0 })], next_cursor: null },
    { venue_id: VENUE, at: AT, sessions: [offer()], next_cursor: SESSION }, { venue_id: VENUE, at: 'later', sessions: [], next_cursor: null }])
    assert.equal((await client.loadOffers(transport(response(body)), VENUE, null)).failure.kind, 'unavailable');
  page = await client.loadOffers(transport(response({ venue_id: VENUE, at: AT, sessions: [offer()], next_cursor: null })), VENUE, SESSION);
  assert.equal(page.failure.kind, 'unavailable', 'a page after a cursor never repeats it');
  const one = await client.loadOffer(transport(response({ at: AT, session: offer() }), seen), SESSION);
  assert.equal(one.ok, true); assert.deepEqual(Object.fromEntries(seen.url.searchParams), { section: 'session', session_id: SESSION });
  assert.equal((await client.loadOffer(transport(response({ at: AT, session: second })), SESSION)).failure.kind, 'unavailable');
  assert.deepEqual(plain((await client.loadOffer(transport(response({ error: 'venue_unavailable' }, 404)), SESSION)).failure),
    { kind: 'rejected', reason: 'venue_unavailable', retryAfterSeconds: null });
});

test('history accepts only ascending player groups; detail must match the requested booking', async () => {
  const next = booking({ id: 'd3000000-0000-4000-8000-000000000002' }); const seen = {};
  const page = await client.loadGroupHistory(transport(response({ bookings: [booking(), next], next_cursor: null }), seen), null);
  assert.equal(page.ok, true); assert.deepEqual(Object.fromEntries(seen.url.searchParams), { section: 'history' });
  for (const body of [{ bookings: [next, booking()], next_cursor: null }, { bookings: [booking({ source: 'walk_in' })], next_cursor: null },
    { bookings: [booking()], next_cursor: BOOKING }, { bookings: [booking({ participants: ['Ana', 'ana'] })], next_cursor: null }])
    assert.equal((await client.loadGroupHistory(transport(response(body)), null)).failure.kind, 'unavailable');
  assert.equal((await client.loadGroupHistory(transport(response({ bookings: [booking()], next_cursor: null })), BOOKING)).failure.kind, 'unavailable');
  const detail = await client.loadGroupBooking(transport(response({ booking: booking({ status: 'pending', expires_at: '2026-10-09T03:00:00+00:00',
    snapshot: { ...booking().snapshot, policy: { confirmation: 'approval', payment: 'arrival', merchant_active: false } } }) }), seen), BOOKING);
  assert.equal(detail.value.status, 'pending'); assert.equal(detail.value.expires_at, '2026-10-09T03:00:00.000Z');
  assert.deepEqual(Object.fromEntries(seen.url.searchParams), { section: 'booking', booking_id: BOOKING });
  assert.equal((await client.loadGroupBooking(transport(response({ booking: next })), BOOKING)).failure.kind, 'unavailable');
  const merged = rentalModel.mergeHistory([booking()], { bookings: [next, booking({ status: 'cancelled' })], next_cursor: null }, BOOKING);
  assert.deepEqual(plain(merged.map(b => [b.id.slice(-1), b.status])), [['2', 'confirmed'], ['1', 'cancelled']]);
});

test('group requests send exactly the reviewed names/total and treat any mismatched success as uncertain', async () => {
  const seen = {}; let reply = { outcome: 'created', booking: booking() };
  const t = transport(() => response(reply), seen);
  const ok = await client.requestGroup(t, parsed);
  assert.equal(ok.ok, true); assert.deepEqual(seen.body, { kind: 'request', session_id: SESSION, request_id: REQUEST, participants: ['Ana', 'Ben'], expected_total_centavos: 50000 });
  assert.equal(seen.init.method, 'POST'); assert.equal(seen.url.search, ''); assert.equal(seen.init.headers.Authorization, 'Bearer fixture-token');
  reply = { outcome: 'existing', booking: booking({ status: 'cancelled' }) }; assert.equal((await client.requestGroup(t, parsed)).value.booking.status, 'cancelled');
  for (const b of [booking({ source: 'walk_in' }), booking({ session_id: VENUE }), booking({ participants: ['Ben', 'Ana'] }),
    booking({ participants: ['Ana', 'Ben', 'Cy'], spots: 3, snapshot: { ...booking().snapshot, spots: 3, total_centavos: 75000 } })]) {
    reply = { outcome: 'created', booking: b }; assert.equal((await client.requestGroup(t, parsed)).failure.kind, 'unavailable');
  }
  reply = { outcome: 'created', booking: booking({ status: 'cancelled' }) }; assert.equal((await client.requestGroup(t, parsed)).failure.kind, 'unavailable');
  reply = { outcome: 'changed', booking: booking() }; assert.equal((await client.requestGroup(t, parsed)).failure.kind, 'unavailable');
  assert.throws(() => client.requestGroup(t, { ...parsed, participants: ['Ana', 'ana'] }));
  const failure = async (body, status, headers) => (await client.requestGroup(transport(response(body, status, headers)), parsed)).failure;
  assert.deepEqual(plain(await failure({ error: 'session_full' }, 409)), { kind: 'rejected', reason: 'session_full', retryAfterSeconds: null });
  assert.deepEqual(plain(await failure({ error: 'invalid_auth' }, 401)), { kind: 'sign_in', retryAfterSeconds: null });
  assert.deepEqual(plain(await failure({ error: 'rate_limited' }, 429, { 'Retry-After': '17' })), { kind: 'rate_limited', retryAfterSeconds: 17 });
  assert.deepEqual(plain(await failure({ error: 'temporarily_unavailable' }, 503, { 'Retry-After': '5' })), { kind: 'unavailable', retryAfterSeconds: 5 });
  assert.equal((await client.requestGroup({ ...transport(null), fetch: async () => { throw new Error('offline'); } }, parsed)).failure.kind, 'network');
  assert.equal((await client.requestGroup({ ...transport(null), accessToken: async () => null }, parsed)).failure.kind, 'sign_in');
});

test('cancellation is retry-safe: it reports cancelled or expired records for the same player group only', async () => {
  const seen = {}; let reply = { outcome: 'changed', booking: booking({ status: 'cancelled' }) };
  const t = transport(() => response(reply), seen);
  assert.equal((await client.cancelGroup(t, BOOKING)).ok, true); assert.deepEqual(seen.body, { kind: 'cancel', booking_id: BOOKING });
  reply = { outcome: 'existing', booking: booking({ status: 'cancelled' }) }; assert.equal((await client.cancelGroup(t, BOOKING)).value.outcome, 'existing');
  reply = { outcome: 'expired', booking: booking({ status: 'expired', expires_at: '2026-10-09T03:00:00+00:00' }) }; assert.equal((await client.cancelGroup(t, BOOKING)).value.booking.status, 'expired');
  for (const b of [booking(), booking({ id: 'd3000000-0000-4000-8000-000000000002', status: 'cancelled' }), booking({ source: 'walk_in', status: 'cancelled' })]) {
    reply = { outcome: 'changed', booking: b }; assert.equal((await client.cancelGroup(t, BOOKING)).failure.kind, 'unavailable');
  }
  assert.equal((await client.cancelGroup(transport(response({ error: 'invalid_transition' }, 409)), BOOKING)).failure.reason, 'invalid_transition');
});

test('group journal saves before dispatch, survives restart, serializes taps and forgets only definitive refusals', async () => {
  const store = memory(); const { values, operations } = store;
  const first = createGroupJournal(store, 'local.player'); let resolve;
  const running = first.run(parsed, async original => { operations.push('send'); assert.deepEqual(plain(await first.read()), plain(original)); return new Promise(done => { resolve = done; }); });
  while (!resolve) await new Promise(done => setTimeout(done, 0));
  await assert.rejects(first.run(parsed, async () => { throw new Error('Duplicate tap dispatched'); }));
  resolve({ ok: false, failure: { kind: 'network', retryAfterSeconds: null } }); await running;
  assert.deepEqual(operations, ['persist', 'send']); assert.ok([...values.keys()][0].endsWith('.group-attempt'));
  const restarted = createGroupJournal(store, 'local.player'); assert.deepEqual(plain(await restarted.read()), plain(parsed));
  await assert.rejects(restarted.run({ ...parsed, participants: ['Ana'], expected_total_centavos: 25000 }, async () => { throw new Error('must not send'); }));
  assert.equal(await createGroupJournal(store, 'local.other').read(), null);
  for (const failure of [{ kind: 'sign_in', retryAfterSeconds: null }, { kind: 'rate_limited', retryAfterSeconds: 17 }, { kind: 'unavailable', retryAfterSeconds: 5 },
    { kind: 'rejected', reason: 'request_reused', retryAfterSeconds: null }]) {
    await restarted.run(parsed, async () => ({ ok: false, failure })); assert.notEqual(await restarted.read(), null, failure.kind);
  }
  await restarted.run(parsed, async () => ({ ok: false, failure: { kind: 'rejected', reason: 'session_full', retryAfterSeconds: null } }));
  assert.equal(await restarted.read(), null);
  await restarted.run(parsed, async () => ({ ok: true, value: { outcome: 'created', booking: booking() } })); assert.equal(await restarted.read(), null);
  const failing = createGroupJournal({ ...store, set: async () => { throw new Error('keychain'); } }, 'local.broken');
  await assert.rejects(failing.run(parsed, async () => { throw new Error('must not send without durability'); }), /keychain/);
});

test('preview uses the server read time, immutable price × names and the group/spot limits; status copy never overstates', () => {
  const o = client.parseOffer(offer()); const at = '2026-10-09T01:00:00.000Z';
  assert.equal(model.offerState(o, at), 'open'); assert.equal(model.offerState(o, '2026-10-10T10:00:00.000Z'), 'started');
  assert.equal(model.offerState(client.parseOffer(offer({ available_spots: 0 })), at), 'full');
  assert.equal(model.offerState(client.parseOffer(offer({ status: 'cancelled', available_spots: 0 })), at), 'cancelled');
  assert.equal(model.spotsLabel(o, at), '5 of 8 spots left'); assert.equal(model.maxGroupRows(o), 4);
  assert.equal(model.maxGroupRows(client.parseOffer(offer({ available_spots: 2 }))), 2); assert.equal(model.maxGroupRows(client.parseOffer(offer({ available_spots: 0 }))), 1);
  const ok = model.groupPreview(o, at, [' Ana ', '', 'Ben']);
  assert.equal(ok.ok, true); assert.deepEqual(plain(ok.names), ['Ana', 'Ben']); assert.equal(ok.total_centavos, 50000); assert.match(ok.text, /2 people × ₱250\.00 = ₱500\.00/);
  for (const [rows, pattern, value = o, when = at] of [[[''], /at least one/], [['A', 'B', 'C', 'D', 'E'], /Up to 4 people/], [['Ana', 'ANA'], /no repeated/],
    [['a'.repeat(61)], /1–60/], [['A', 'B', 'C'], /Only 2 spots/, client.parseOffer(offer({ available_spots: 2 }))], [['Ana'], /started/, o, '2026-10-10T10:00:00.000Z'],
    [['Ana'], /full/, client.parseOffer(offer({ available_spots: 0 }))], [['Ana'], /cancelled/, client.parseOffer(offer({ status: 'cancelled', available_spots: 0 }))],
    [['Ana'], /online payment only/, client.parseOffer(offer({}, { policy: { confirmation: 'instant', payment: 'online', merchant_active: true } }))]]) {
    const preview = model.groupPreview(value, when, rows); assert.equal(preview.ok, false); assert.match(preview.text, pattern);
  }
  assert.deepEqual(plain(parsed), { kind: 'request', session_id: SESSION, request_id: REQUEST, participants: ['Ana', 'Ben'], expected_total_centavos: 50000 });
  const labels = Object.fromEntries(['pending', 'confirmed', 'declined', 'cancelled', 'expired'].map(status => [status, model.groupStatus({ status })]));
  assert.equal(labels.pending.label, 'Awaiting approval'); assert.match(labels.pending.text, /not confirmed/);
  assert.match(labels.confirmed.text, /Payment is still due at the venue/);
  for (const status of ['declined', 'cancelled', 'expired']) assert.match(labels[status].text, /no longer holds spots/);
  for (const reason of ['session_full', 'group_limit_exceeded', 'already_booked', 'stale_quote', 'session_cancelled', 'session_started', 'session_ended',
    'arrival_unavailable', 'venue_unavailable', 'session_not_found', 'invalid_transition', 'request_reused'])
    assert.doesNotMatch(client.groupFailureMessage({ kind: 'rejected', reason, retryAfterSeconds: null }), /Check the names/, reason);
  assert.match(client.groupFailureMessage({ kind: 'network', retryAfterSeconds: null }), /uncertain/);
  assert.equal(model.canForgetGroupAttempt({ kind: 'rejected', reason: 'request_reused', retryAfterSeconds: null }), false);
});
