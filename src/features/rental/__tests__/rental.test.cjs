const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { load, client, model, createAttemptJournal, COURT, ID, REQUEST, quote, booking, plain, response, transport, memory } = require('./helpers.cjs');
const window = () => { const q = quote(); return { court_id: q.court_id, starts_at: q.starts_at, ends_at: q.ends_at }; };

test('quote preserves exact full total, bands, policy and revisions; accepts PostgreSQL microseconds', () => {
  const q = client.parseQuote(quote());
  assert.equal(q.total_centavos, 70000); assert.equal(q.bands.length, 2); assert.equal(q.quoted_at, '2026-10-08T01:00:00.123Z');
  assert.deepEqual(plain(q.expected_quote), quote().expected_quote);
  for (const patch of [{ total_centavos: 70001 }, { total_centavos: Number.MAX_SAFE_INTEGER + 1 }, { currency: 'USD' }, { duration_minutes: 60 },
    { expected_quote: { ...quote().expected_quote, total_centavos: 1 } }, { policy: { confirmation: 'instant', payment: 'online', merchant_active: true } },
    { starts_at: '2026-02-30T10:00:00Z' }, { starts_at: '2026-10-10T10:00:00' }]) assert.throws(() => client.parseQuote({ ...quote(), ...patch }));
  const qGap = quote(); qGap.bands[1].starts_at = '2026-10-10T11:30:00Z'; assert.throws(() => client.parseQuote(qGap));
});
test('all authoritative lifecycle statuses and original snapshot display survive parsing', () => {
  for (const status of ['pending', 'confirmed', 'declined', 'cancelled', 'expired']) {
    const b = client.parseBooking(booking(status)); assert.equal(b.status, status); assert.equal(b.payment_status, 'unpaid');
    assert.equal(b.snapshot.total_centavos, 70000); assert.ok(model.bookingStatus(b).text.length > 20);
  }
  assert.match(model.bookingStatus(client.parseBooking(booking('confirmed'))).text, /Payment is still due/);
  const tampered = booking(); tampered.snapshot.court_id = ID; assert.throws(() => client.parseBooking(tampered));
  const paid = booking(); paid.payment_status = 'paid'; assert.throws(() => client.parseBooking(paid));
  const ended = booking('pending'); ended.allocation.state = 'expired'; assert.throws(() => client.parseBooking(ended));
});
test('Manila selection handles midnight/overnight and validates shape without judging the local clock', () => {
  const w = model.rentalWindow(COURT, '2026-10-10', '23:30', '90');
  assert.equal(w.starts_at, '2026-10-10T15:30:00.000Z'); assert.equal(w.ends_at, '2026-10-10T17:00:00.000Z');
  assert.doesNotThrow(() => model.rentalWindow(COURT, '2020-01-01', '00:00', '60')); // Server judges future/horizon.
  for (const args of [['2026-02-30', '18:00', '60'], ['2026-10-10', '18:15', '60'], ['2026-10-10', '25:00', '60'],
    ['2026-10-10', '18:00', '30'], ['2026-10-10', '18:00', '75'], ['2026-10-10', '18:00', '1470']]) assert.throws(() => model.rentalWindow(COURT, ...args));
});
test('authenticated native-shaped transport sends only reviewed values and rejects wrong-window replies', async () => {
  let sent; const t = transport(async (url, init) => { sent = { url, init }; return response({ quote: quote() }); });
  assert.equal((await client.loadQuote(t, window())).ok, true);
  assert.equal(sent.init.headers.Authorization, 'Bearer fixture-token'); assert.match(sent.url, /section=quote/);
  const mismatch = quote(); mismatch.court_id = ID;
  assert.equal((await client.loadQuote(transport(async () => response({ quote: mismatch })), window())).ok, false);
  t.fetch = async (url, init) => { sent = { url, init }; return response({ outcome: 'created', booking: booking() }); };
  const command = model.reviewedRequest(client.parseQuote(quote()), REQUEST);
  assert.equal((await client.requestRental(t, command)).ok, true);
  assert.deepEqual(JSON.parse(sent.init.body), plain(command)); assert.equal('actor_user_id' in JSON.parse(sent.init.body), false);
  const wrong = booking(); wrong.allocation.starts_at = '2026-10-11T10:00:00Z';
  assert.equal((await client.requestRental(transport(async () => response({ outcome: 'created', booking: wrong })), command)).ok, false);
  const wrongReview = booking(); wrongReview.snapshot.policy_revision = '9';
  assert.equal((await client.requestRental(transport(async () => response({ outcome: 'created', booking: wrongReview })), command)).ok, false);
});
test('401 blocks anonymous booking, actionable conflicts/503/429 retain sanitized recovery info', async () => {
  let calls = 0; const guest = transport(async () => { calls++; return response({ quote: quote() }); }); guest.accessToken = async () => null;
  assert.equal((await client.loadQuote(guest, window())).failure.kind, 'sign_in'); assert.equal(calls, 0);
  for (const reason of ['stale_quote', 'allocation_conflict', 'arrival_unavailable', 'outside_hours', 'start_not_future']) {
    const result = await client.loadQuote(transport(async () => response({ error: reason }, 409)), window());
    assert.equal(result.failure.reason, reason); assert.ok(client.rentalFailureMessage(result.failure).length > 25);
  }
  const throttled = await client.loadQuote(transport(async () => response({ error: 'rate_limited' }, 429, { 'Retry-After': '7' })), window());
  assert.equal(throttled.failure.retryAfterSeconds, 7);
  const unavailable = await client.loadQuote(transport(async () => response({ error: 'database secret text' }, 503, { 'Retry-After': '5' })), window());
  assert.equal(unavailable.failure.retryAfterSeconds, 5); assert.doesNotMatch(client.rentalFailureMessage(unavailable.failure), /secret/);
});
test('account-bound live transport cannot submit with another account’s refreshed token', async () => {
  let actor = ID;
  const live = load(path.join(path.dirname(module.filename), '../live.ts'), {
    '@/lib/supabase': { getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: actor }, access_token: 'fixture' } }, error: null }) } }) },
    '@/lib/fetchWithDeadline': { fetchWithDeadline: async () => { throw new Error('not used'); } },
    '@/lib/recoveryKeys': require(path.join(path.dirname(module.filename), '../../../lib/recoveryKeys.ts')), './attempt': { createAttemptJournal }, './attemptStore': { attemptStore: memory() },
  }, { process: { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.co', EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fixture' } } });
  const services = live.rentalServices(ID); assert.equal(await services.transport.accessToken(), 'fixture');
  actor = REQUEST; assert.equal(await services.transport.accessToken(), null);
  assert.notEqual(live.rentalServices(REQUEST).journal, services.journal);
});
test('lost create reply survives journal recreation; exact original retry returns one booking', async () => {
  const store = memory(); let creates = 0; let replyLost = true; let savedBody;
  const command = model.reviewedRequest(client.parseQuote(quote()), REQUEST);
  const t = transport(async (_, init) => {
    assert.equal(store.values.size, 1); store.operations.push('send');
    const incoming = JSON.parse(init.body);
    if (!savedBody) { savedBody = incoming; creates++; }
    else assert.deepEqual(incoming, savedBody);
    if (replyLost) { replyLost = false; throw new Error('reply lost after commit'); }
    return response({ outcome: 'existing', booking: booking() });
  });
  const first = createAttemptJournal(store, 'backend.player');
  assert.equal((await first.run(command, c => client.requestRental(t, c))).failure.kind, 'network');
  assert.deepEqual(store.operations, ['persist', 'send']);
  const restored = createAttemptJournal(store, 'backend.player'); const original = await restored.read();
  assert.deepEqual(plain(original), plain(command));
  await assert.rejects(restored.run({ ...command, request_id: ID }, c => client.requestRental(t, c)), /Resolve your original/);
  assert.equal((await restored.run(original, c => client.requestRental(t, c))).value.booking.status, 'confirmed');
  assert.equal(creates, 1); assert.equal(await restored.read(), null);
});
test('storage failure prevents dispatch; double tap is blocked while the original runs', async () => {
  const command = model.reviewedRequest(client.parseQuote(quote()), REQUEST); let sent = 0;
  const journal = createAttemptJournal({ ...memory(), set: async () => { throw new Error('locked keychain'); } }, 'fixture');
  await assert.rejects(journal.run(command, async () => { sent++; }), /locked keychain/); assert.equal(sent, 0);
  let resolve; const port = memory(); const j = createAttemptJournal(port, 'fixture');
  const first = j.run(command, () => new Promise(r => { resolve = r; }));
  await new Promise(r => setImmediate(r));
  await assert.rejects(j.run(command, async () => { sent++; }), /already running/);
  resolve({ ok: true, value: { outcome: 'created', booking: client.parseBooking(booking()) } }); await first;
  assert.equal(sent, 0); assert.equal(await j.read(), null);
});
test('definitive stale quote clears the old review; auth/Redis/429/reused identity keep the attempt', async () => {
  const command = model.reviewedRequest(client.parseQuote(quote()), REQUEST);
  for (const failure of [{ kind: 'sign_in', retryAfterSeconds: null }, { kind: 'unavailable', retryAfterSeconds: 5 },
    { kind: 'rate_limited', retryAfterSeconds: 3 }, { kind: 'rejected', reason: 'request_reused', retryAfterSeconds: null },
    { kind: 'rejected', reason: 'stale_quote', retryAfterSeconds: null }, { kind: 'rejected', reason: 'allocation_conflict', retryAfterSeconds: null }]) {
    const store = memory(); const j = createAttemptJournal(store, 'fixture');
    await j.run(command, async () => ({ ok: false, failure }));
    assert.equal((await j.read()) === null, model.canForgetAttempt(failure));
  }
});
test('history validates ascending keyset pages; refresh replaces records and paging de-duplicates', async () => {
  const rows = Array.from({ length: 25 }, (_, n) => { const b = booking(); b.id = `c2500000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`; b.allocation.id = b.id; b.snapshot.allocation_id = b.id; return b; });
  const page = await client.loadHistory(transport(async () => response({ bookings: rows, next_cursor: rows.at(-1).id })), null);
  assert.equal(page.ok, true); assert.equal(page.value.bookings.length, 25);
  const reversed = await client.loadHistory(transport(async () => response({ bookings: rows.toReversed(), next_cursor: null })), null); assert.equal(reversed.ok, false);
  const invalidCursor = await client.loadHistory(transport(async () => response({ bookings: [booking()], next_cursor: ID })), null); assert.equal(invalidCursor.ok, false);
  const b = client.parseBooking(booking()); const cancelled = client.parseBooking(booking('cancelled'));
  assert.equal(model.mergeHistory([b], { bookings: [cancelled], next_cursor: null }, null)[0].status, 'cancelled');
  assert.equal(model.mergeHistory([b], { bookings: [b], next_cursor: null }, ID).length, 1);
});
test('cancel retries use the same booking ID and render server-projected expired holds without revival', async () => {
  let calls = 0; const bodies = [];
  const t = transport(async (_, init) => { bodies.push(init.body); if (++calls === 1) throw new Error('lost cancellation reply');
    return response({ outcome: 'existing', booking: booking('cancelled') }); });
  assert.equal((await client.cancelRental(t, ID)).ok, false);
  const retried = await client.cancelRental(t, ID); assert.equal(retried.value.booking.status, 'cancelled'); assert.equal(bodies[0], bodies[1]);
  const expired = await client.loadBooking(transport(async () => response({ booking: booking('expired') })), ID);
  assert.equal(expired.value.status, 'expired'); assert.equal(expired.value.allocation.state, 'expired');
  assert.equal(expired.value.snapshot.total_centavos, 70000);
});
