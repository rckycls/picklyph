const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('./load-ts.cjs');
const fn = (name, file) => path.join(__dirname, '../functions', name, file);
const rentalHandler = load(fn('rental-bookings', 'handler.ts'), {}, { TextDecoder });
const groupHandler = load(fn('session-bookings', 'handler.ts'), {}, { TextDecoder });
const sessionHandler = load(fn('owner-sessions', 'handler.ts'), {}, { TextDecoder });
const rentalDeps = load(fn('rental-bookings', 'deps.ts'), { './handler.ts': rentalHandler }, { TextDecoder, atob });
const groupDeps = load(fn('session-bookings', 'deps.ts'), { './handler.ts': groupHandler }, { TextDecoder, atob });
const sessionDeps = load(fn('owner-sessions', 'deps.ts'), { './handler.ts': sessionHandler }, { TextDecoder, atob });
const { createRateGuard } = load(fn('_shared', 'rate-limit.ts'));

const id = 'ca000000-0000-4000-8000-000000000001';
const allowed = { allowed: true, status: 200, state: 'enforced', headers: {} };
const endpoints = [
  ['rental-bookings', rentalHandler.createRentalHandler, rentalHandler.RentalRejected, { kind: 'venue_cancel', booking_id: id, reason: 'weather' }],
  ['session-bookings', groupHandler.createSessionBookingHandler, groupHandler.SessionBookingRejected, { kind: 'venue_cancel', booking_id: id, reason: 'weather' }],
  ['owner-sessions', sessionHandler.createSessionHandler, sessionHandler.SessionRejected, { kind: 'cancel', session_id: id, reason: 'weather' }],
];
const post = (body, token = 'valid') => new Request('https://cancel.local', { method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const base = () => ({ verifyUser: async (token) => token === 'valid' ? id : null, limit: async () => allowed, read: async () => ({}), command: async () => ({ outcome: 'changed' }) });

test('venue cancellations: verified actor only, strict bodies, the cancel bucket, and processing during a Redis outage', async () => {
  for (const [name, create, Rejected, body] of endpoints) {
    const seen = []; const commands = []; const deps = base();
    deps.limit = async (action, principal) => { seen.push(action); assert.equal(principal.id, id); return allowed; };
    deps.command = async (actor, command) => { commands.push([actor, JSON.parse(JSON.stringify(command))]); return { outcome: 'changed' }; };
    const handler = create(deps);
    assert.equal((await handler(post(body, 'forged'))).status, 401, name);
    for (const bad of [{ ...body, actor_user_id: id }, { ...body, reason: 'rain' }, { ...body, refund_centavos: 0 }]) {
      assert.equal((await handler(post(bad))).status, 400, `${name}: ${JSON.stringify(bad)}`);
    }
    assert.equal((await handler(post(body))).status, 200, name);
    assert.deepEqual(seen, ['cancel'], `${name}: cancellations share the cancel bucket`);
    assert.deepEqual(commands, [[id, name === 'owner-sessions' ? { kind: 'cancel', session_id: id, reason: 'weather' } : body]], name);
    // A limiter outage never blocks a cancellation, and a server refusal maps to a definite status.
    deps.limit = createRateGuard({ backend: async () => { throw new Error('Outage'); }, identifier: async () => id, timeoutMs: 5 });
    assert.equal((await create(deps)(post(body))).status, 200, `${name}: outage`);
    deps.limit = async () => allowed; deps.command = async () => { throw new Rejected('payment_collected'); };
    const refused = await create(deps)(post(body));
    assert.equal(refused.status, 409, name); assert.deepEqual(await refused.json(), { error: 'payment_collected' });
  }
});

test('deps send the verified actor, the booking kind and the reason to the service-only commands', async () => {
  const calls = []; const server = () => ({ rpc: async (fnName, args) => { calls.push([fnName, args]); return { data: { outcome: 'changed' }, error: null }; } });
  const verifier = () => ({ auth: { getUser: async () => ({ data: { user: { id } }, error: null }) } });
  await rentalDeps.createSupabaseRentalDeps(verifier, server).command(id, { kind: 'venue_cancel', booking_id: id, reason: 'maintenance' });
  await groupDeps.createSupabaseSessionBookingDeps(verifier, server).command(id, { kind: 'venue_cancel', booking_id: id, reason: 'other' });
  await sessionDeps.createSupabaseSessionDeps(verifier, server).command(id, { kind: 'cancel', session_id: id, reason: null });
  await sessionDeps.createSupabaseSessionDeps(verifier, server).command(id, { kind: 'cancel', session_id: id, reason: 'venue_closed' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['owner_booking_cancel', { actor_user_id: id, target_kind: 'rental', target_booking_id: id, reason: 'maintenance' }],
    ['owner_booking_cancel', { actor_user_id: id, target_kind: 'session', target_booking_id: id, reason: 'other' }],
    ['owner_session_cancel', { actor_user_id: id, target_session_id: id, reason: null }],
    ['owner_session_cancel', { actor_user_id: id, target_session_id: id, reason: 'venue_closed' }],
  ]);
  // Server hints become definite refusals; anything else stays a retryable failure.
  const refusing = (hint) => () => ({ rpc: async () => ({ data: null, error: { code: '55000', hint } }) });
  await assert.rejects(rentalDeps.createSupabaseRentalDeps(verifier, refusing('payment_collected')).command(id, { kind: 'venue_cancel', booking_id: id, reason: 'weather' }),
    (e) => e instanceof rentalHandler.RentalRejected && e.reason === 'payment_collected');
  await assert.rejects(groupDeps.createSupabaseSessionBookingDeps(verifier, refusing('invalid_transition')).command(id, { kind: 'venue_cancel', booking_id: id, reason: 'weather' }),
    (e) => e instanceof groupHandler.SessionBookingRejected && e.reason === 'invalid_transition');
  await assert.rejects(sessionDeps.createSupabaseSessionDeps(verifier, refusing('session_has_bookings')).command(id, { kind: 'cancel', session_id: id, reason: null }),
    (e) => e instanceof sessionHandler.SessionRejected && e.reason === 'session_has_bookings');
  await assert.rejects(rentalDeps.createSupabaseRentalDeps(verifier, refusing('mystery')).command(id, { kind: 'venue_cancel', booking_id: id, reason: 'weather' }),
    (e) => !(e instanceof rentalHandler.RentalRejected));
});
