const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');
const domain = require('../../../../packages/domain/src/owner.ts');
const { findNearbyListings, ownerFailureMessage, parseMySubmissions, parseSubmission, searchAddress, submitOwner } = require('../ownerClient.ts');
const here = path.dirname(module.filename);
const root = path.resolve(here, '../../../..');
const form = load(path.join(here, '../ownerForm.ts'), { '@picklyph/domain': domain });
const { createOwnerHandler, CommandRejected } = load(path.join(root, 'supabase/functions/owner-submissions/handler.ts'), {}, { AbortSignal, FormData, Blob });

const plain = (value) => JSON.parse(JSON.stringify(value));
const ACTOR = 'a2000000-0000-4000-8000-000000000001';
const VENUE = 'b2000000-0000-4000-8000-000000000001';
const REQUEST = 'c2000000-0000-4000-8000-000000000001';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const submission = { id: 'd2000000-0000-4000-8000-000000000001', kind: 'venue', status: 'pending', venue_id: null, name: 'Corner Courts', city: 'Manila', created_at: '2026-10-07T01:02:03.456789+00:00' };
const duplicate = { id: VENUE, name: 'Alpha Courts', address_line: '1 Fixture St', city: 'Manila', province: 'Metro Manila', claim_status: 'unclaimed', distance_m: 42 };
const evidence = { uri: 'file:///photo.jpg', name: 'evidence.jpg', type: 'image/jpeg', size: JPEG.length };

/** The shipped client against the real Edge handler, with in-memory dependencies. */
function server(overrides = {}) {
  const seen = { submit: [], limit: [] };
  const handler = createOwnerHandler({
    verifyUser: async (token) => (token === 'user-token' ? ACTOR : null),
    limit: async (action) => { seen.limit.push(action); return { allowed: true, status: 200, state: 'enforced', headers: {} }; },
    geocode: async () => [{ label: '1 Fixture St, Makati City, Metro Manila, Philippines', address_line: '1 Fixture St', city: 'Makati City', province: '', latitude: 14.56, longitude: 121.02 }],
    nearby: async () => [duplicate],
    upload: async () => {}, remove: async () => {},
    submit: async (actor, request) => { seen.submit.push([actor, request]); return { outcome: 'created', submission, duplicates: [] }; },
    newId: () => 'e2000000-0000-4000-8000-000000000001',
    ...overrides,
  });
  const transport = {
    endpoint: 'https://test.local/functions/v1/owner-submissions', apiKey: 'public-key', accessToken: async () => 'user-token',
    fetch: (url, init) => handler(new Request(url, init)), evidencePart: () => new Blob([JPEG]),
  };
  return { seen, transport };
}

test('address search, nearby listings and submissions round-trip through the real handler contract', async () => {
  const { transport, seen } = server();
  const found = await searchAddress(transport, '1 Fixture St');
  assert.ok(found.ok); assert.equal(found.value[0].city, 'Makati City');
  const near = await findNearbyListings(transport, { latitude: 14.6000004, longitude: 121 }, 'Corner');
  assert.ok(near.ok); assert.deepEqual(near.value, [duplicate]);
  const built = form.venueRequest({ name: ' Corner  Courts ', address_line: '1 Fixture St', city: 'Manila', province: 'Metro Manila', courts: '3', note: '' },
    { latitude: 14.60000049, longitude: 121.0000001 }, REQUEST, true);
  assert.ok(built.ok);
  const sent = await submitOwner(transport, plain(built.request), evidence);
  assert.ok(sent.ok); assert.equal(sent.value.status, 'created'); assert.equal(sent.value.submission.status, 'pending');
  assert.equal(seen.submit[0][0], ACTOR, 'actor comes from the verified token');
  assert.deepEqual(plain(seen.submit[0][1].venue), { name: 'Corner Courts', address_line: '1 Fixture St', city: 'Manila', province: 'Metro Manila', latitude: 14.6, longitude: 121, court_count: 3 });
  assert.deepEqual(seen.limit, ['owner-lookup', 'owner-lookup', 'owner-submit']);
});

test('duplicate warnings, retries, rejections, limits and outages map to actionable client outcomes', async () => {
  const request = plain(form.claimRequest(VENUE, 'I run the front desk.', REQUEST).request);
  const duplicates = await submitOwner(server({ submit: async () => ({ outcome: 'duplicates', submission: null, duplicates: [duplicate] }) }).transport, request, evidence);
  assert.ok(duplicates.ok); assert.equal(duplicates.value.status, 'duplicates'); assert.equal(duplicates.value.duplicates[0].distance_m, 42);
  const retried = await submitOwner(server({ submit: async () => ({ outcome: 'existing', submission, duplicates: [] }) }).transport, request, evidence);
  assert.ok(retried.ok); assert.equal(retried.value.status, 'existing');
  for (const reason of ['already_pending', 'already_verified', 'too_many_pending', 'listing_unavailable']) {
    const result = await submitOwner(server({ submit: async () => { throw new CommandRejected(reason); } }).transport, request, evidence);
    assert.deepEqual(result, { ok: false, failure: { kind: 'rejected', reason, retryAfterSeconds: null } });
  }
  const limited = await submitOwner(server({ limit: async () => ({ allowed: false, status: 429, state: 'enforced', headers: { 'Retry-After': '12' } }) }).transport, request, evidence);
  assert.deepEqual(limited, { ok: false, failure: { kind: 'rate_limited', retryAfterSeconds: 12 } });
  const outage = await submitOwner(server({ limit: async () => ({ allowed: false, status: 503, state: 'degraded', headers: { 'Retry-After': '5' } }) }).transport, request, evidence);
  assert.equal(outage.ok, false); assert.equal(outage.failure.kind, 'unavailable');
  const noSearch = await searchAddress(server({ geocode: null }).transport, 'Manila');
  assert.equal(noSearch.failure.kind, 'address_search_unavailable');
  const { transport } = server();
  let called = false;
  const signedOut = await submitOwner({ ...transport, accessToken: async () => null, fetch: async () => { called = true; } }, request, evidence);
  assert.equal(signedOut.failure.kind, 'sign_in'); assert.equal(called, false, 'never sent anonymously');
  assert.equal((await submitOwner({ ...transport, accessToken: async () => 'expired' }, request, evidence)).failure.kind, 'sign_in');
  assert.equal((await submitOwner({ ...transport, fetch: async () => { throw new TypeError('offline'); } }, request, evidence)).failure.kind, 'network');
  const odd = await submitOwner({ ...transport, fetch: async () => new Response(JSON.stringify({ submission: { ...submission, status: 'approved-ish' }, duplicates: [] }), { status: 201 }) }, request, evidence);
  assert.equal(odd.failure.kind, 'unavailable', 'unexpected shapes are never shown as success');
  for (const failure of [{ kind: 'sign_in' }, { kind: 'network' }, { kind: 'rate_limited', retryAfterSeconds: 3 }, { kind: 'unavailable' }, { kind: 'not_configured' },
    { kind: 'address_search_unavailable' }, ...['evidence_too_large', 'unsupported_evidence', 'listing_unavailable', 'already_verified', 'already_pending',
      'too_many_pending', 'account_required', 'request_reused', 'invalid_submission', 'invalid_evidence'].map((reason) => ({ kind: 'rejected', reason }))]) {
    assert.ok(ownerFailureMessage(failure).length > 20, JSON.stringify(failure));
  }
});

test('form drafts produce requests the server parser accepts, and block bad pins/counts/photos on the device', () => {
  const draft = { name: 'Corner Courts', address_line: '1 Fixture St', city: 'Manila', province: 'Metro Manila', courts: '3', note: ' Opened in May. ' };
  const built = form.venueRequest(draft, { latitude: 14.6, longitude: 121 }, REQUEST, false);
  assert.ok(built.ok);
  assert.deepEqual(plain(domain.readOwnerSubmission(JSON.stringify(built.request))), plain(built.request), 'mobile and server contracts agree');
  assert.equal(built.request.note, 'Opened in May.');
  for (const [changes, pin] of [[{}, null], [{}, { latitude: 35.6, longitude: 139.7 }], [{ courts: '0' }, { latitude: 14.6, longitude: 121 }],
    [{ courts: 'two' }, { latitude: 14.6, longitude: 121 }], [{ name: ' ' }, { latitude: 14.6, longitude: 121 }]]) {
    const result = form.venueRequest({ ...draft, ...changes }, pin, REQUEST, false);
    assert.equal(result.ok, false); assert.ok(result.message.length > 5);
  }
  assert.equal(form.claimRequest(VENUE, 'x'.repeat(501), REQUEST).ok, false);
  const candidate = { label: 'L', address_line: 'Suggested St', city: 'Makati City', province: '', latitude: 14.5, longitude: 121 };
  assert.deepEqual(plain(form.applyCandidate({ ...form.EMPTY_DRAFT, city: 'Taguig' }, candidate)),
    { ...plain(form.EMPTY_DRAFT), address_line: 'Suggested St', city: 'Taguig', province: '' }, 'owner text wins; blanks stay blank');
  assert.deepEqual(plain(form.evidenceProblem({ uri: 'file:///a.HEIC', mimeType: 'image/heic' })), { problem: 'Choose a JPEG or PNG photo.' });
  assert.deepEqual(plain(form.evidenceProblem({ uri: 'file:///a.png' })), { type: 'image/png' });
  assert.ok('problem' in form.evidenceProblem({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', fileSize: 5 * 1024 * 1024 + 1 }));
  assert.equal(form.distanceLabel(42.4), '42 m away'); assert.equal(form.distanceLabel(1250), '1.3 km away');
  assert.equal(form.submissionBadge({ kind: 'claim', status: 'pending' }).label, 'Claim under review');
});

test('submission list parsing is strict and private-field free', () => {
  assert.equal(parseMySubmissions([submission, { ...submission, id: VENUE, kind: 'claim', venue_id: VENUE }]).length, 2);
  for (const bad of [{ ...submission, status: 'published' }, { ...submission, kind: 'claim' }, { ...submission, venue_id: VENUE }, { ...submission, created_at: 'soon' }]) {
    assert.throws(() => parseSubmission(bad));
  }
  assert.ok(!('evidence_path' in parseSubmission({ ...submission, evidence_path: 'x/y.jpg' })));
});
