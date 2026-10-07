const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');
const domain = require('../../../../packages/domain/src/ownerVenues.ts');
const { addVenuePhoto, listOwnedVenues, loadOwnedVenue, removeVenuePhoto, saveOwnedVenue, venueFailureMessage } = require('../venueClient.ts');
const here = path.dirname(module.filename);
const root = path.resolve(here, '../../../..');
const editor = load(path.join(here, '../venueDraft.ts'), { '@picklyph/domain': domain });
const { createVenueHandler, CommandRejected } = load(path.join(root, 'supabase/functions/owner-venues/handler.ts'), {},
  { AbortSignal, FormData, Blob, TextDecoder, DataView });

const plain = (value) => JSON.parse(JSON.stringify(value));
const ACTOR = 'a5000000-0000-4000-8000-000000000001';
const VENUE = 'b5000000-0000-4000-8000-000000000001';
const COURT = 'c5000000-0000-4000-8000-000000000001';
const PHOTO = 'd5000000-0000-4000-8000-000000000001';
const NEW_ID = 'e5000000-0000-4000-8000-000000000001';
const REQUEST = 'f5000000-0000-4000-8000-000000000001';
const VERSION = '2026-10-07T01:02:03.456789+00:00';
const court = { id: COURT, venue_id: VENUE, name: 'Court 1', surface: 'hard', is_indoor: false, is_covered: true, status: 'active', created_at: VERSION, updated_at: VERSION };
const photo = { id: PHOTO, storage_path: `${VENUE}/${PHOTO}.jpg`, width: 1200, height: 900, created_at: VERSION };
const listing = (overrides = {}) => ({ id: VENUE, name: 'Alpha Courts', address_line: '1 Rizal Ave', city: 'Manila', province: 'Metro Manila',
  latitude: 14.6, longitude: 121, publication_status: 'approved', claim_status: 'verified', updated_at: VERSION, courts: [court], photos: [], ...overrides });
const summary = { id: VENUE, name: 'Alpha Courts', city: 'Manila', province: 'Metro Manila', publication_status: 'approved', claim_status: 'verified', editable: true, active_court_count: 1, photo_count: 0 };

/** A structurally valid JPEG with EXIF (orientation 6 + a "GPS" string), a comment and trailing data. */
function jpeg(width = 640, height = 480) {
  const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), Buffer.from(payload)]);
  const ifd = Buffer.from([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]),
    segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0MM\0\x2a\0\0\0\x08', 'latin1'), ifd, Buffer.from('GPS 14.6N 121E')])),
    segment(0xfe, Buffer.from('secret')), segment(0xdb, Buffer.alloc(65, 1)),
    segment(0xc0, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0])),
    segment(0xc4, Buffer.alloc(20, 2)), segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0xff, 0xd9])]));
}

/** The shipped client against the real Edge handler, with in-memory dependencies. */
function server(overrides = {}, file = jpeg()) {
  const seen = { limit: [], save: [], uploaded: [], removed: [], added: [], reads: 0 };
  const handler = createVenueHandler({
    verifyUser: async (token) => (token === 'owner-token' ? ACTOR : null),
    limit: async (action) => { seen.limit.push(action); return { allowed: true, status: 200, state: 'enforced', headers: {} }; },
    list: async () => [summary],
    read: async () => { seen.reads++; return listing(); },
    save: async (actor, command) => { seen.save.push([actor, command]); return listing({ name: command.venue.name, updated_at: '2026-10-07T02:00:00.000001+00:00' }); },
    upload: async (objectPath, bytes, type) => { seen.uploaded.push({ path: objectPath, bytes: Buffer.from(bytes), type }); },
    remove: async (objectPath) => { seen.removed.push(objectPath); },
    addPhoto: async (actor, request, objectPath, width, height) => {
      seen.added.push({ actor, request, path: objectPath, width, height });
      return { outcome: 'created', venue: listing({ photos: [{ ...photo, storage_path: objectPath, width, height }] }) };
    },
    removePhoto: async () => ({ removed_path: photo.storage_path, venue: listing() }),
    newId: () => NEW_ID,
    ...overrides,
  });
  const transport = {
    endpoint: 'https://test.local/functions/v1/owner-venues', apiKey: 'public-key', accessToken: async () => 'owner-token',
    fetch: (url, init) => handler(new Request(url, init)), photoPart: () => new Blob([file]),
  };
  return { seen, transport, handler };
}
const picked = { uri: 'file:///court.jpg', name: 'photo.jpg', type: 'image/jpeg', size: 1000 };

test('owners list, load and save their venue through the real handler contract', async () => {
  const { transport, seen } = server();
  const venues = await listOwnedVenues(transport);
  assert.ok(venues.ok); assert.deepEqual(plain(venues.value), [summary]);
  const loaded = await loadOwnedVenue(transport, VENUE);
  assert.ok(loaded.ok); assert.equal(loaded.value.updated_at, VERSION, 'version string kept exactly');
  const draft = editor.updateCourt(editor.addCourt({ ...editor.draftFrom(loaded.value), name: '  Alpha   Pickleball ' }, 'new-1'), COURT, { status: 'inactive' });
  assert.ok(editor.isDirty(draft, loaded.value));
  const built = editor.saveCommand(draft, loaded.value);
  assert.ok(built.ok, built.message);
  const saved = await saveOwnedVenue(transport, plain(built.command));
  assert.ok(saved.ok); assert.equal(saved.value.name, 'Alpha Pickleball');
  const [actor, command] = seen.save[0];
  assert.equal(actor, ACTOR, 'actor comes from the verified token');
  assert.deepEqual(plain(command), { kind: 'save', venue_id: VENUE, expected_updated_at: VERSION,
    venue: { name: 'Alpha Pickleball', address_line: '1 Rizal Ave', city: 'Manila', province: 'Metro Manila' },
    courts: [{ id: COURT, name: 'Court 1', surface: 'hard', is_indoor: false, is_covered: true, status: 'inactive' },
      { id: null, name: 'Court 2', surface: null, is_indoor: false, is_covered: false, status: 'active' }] });
  assert.deepEqual(seen.limit, ['owner-read', 'owner-read', 'owner-edit']);
});

test('database rejections, limits, outages and bad input map to actionable owner messages', async () => {
  const command = plain(editor.saveCommand(editor.draftFrom(listing()), listing()).command);
  for (const reason of ['version_conflict', 'not_owner', 'venue_unavailable', 'duplicate_court', 'active_court_required', 'too_many_courts', 'court_allocated']) {
    const result = await saveOwnedVenue(server({ save: async () => { throw new CommandRejected(reason); } }).transport, command);
    assert.equal(result.ok, false); assert.equal(result.failure.kind, 'rejected'); assert.equal(result.failure.reason, reason);
    assert.ok(venueFailureMessage(result.failure).length > 20);
  }
  const crashed = await saveOwnedVenue(server({ save: async () => { throw new Error('db down: secret detail'); } }).transport, command);
  assert.deepEqual(crashed, { ok: false, failure: { kind: 'unavailable', retryAfterSeconds: 5 } });
  let bodyRead = false;
  const limited = server({ limit: async () => ({ allowed: false, status: 429, state: 'enforced', headers: { 'Retry-After': '17' } }),
    save: async () => { bodyRead = true; return listing(); } });
  assert.deepEqual(await saveOwnedVenue(limited.transport, command), { ok: false, failure: { kind: 'rate_limited', retryAfterSeconds: 17 } });
  assert.equal(bodyRead, false);
  const outage = server({ limit: async (action) => (action === 'owner-edit'
    ? { allowed: false, status: 503, state: 'degraded', headers: { 'Retry-After': '5' } } : { allowed: true, status: 200, state: 'degraded', headers: {} }) });
  assert.equal((await saveOwnedVenue(outage.transport, command)).failure.kind, 'unavailable', 'edits stop without the limiter');
  assert.ok((await loadOwnedVenue(outage.transport, VENUE)).ok, 'bounded reads continue without the limiter');
  const { transport, handler, seen } = server();
  let sent = false;
  assert.equal((await saveOwnedVenue({ ...transport, accessToken: async () => null, fetch: async () => { sent = true; } }, command)).failure.kind, 'sign_in');
  assert.equal(sent, false, 'never sent anonymously');
  assert.equal((await loadOwnedVenue({ ...transport, accessToken: async () => 'expired' }, VENUE)).failure.kind, 'sign_in');
  assert.equal((await listOwnedVenues({ ...transport, fetch: async () => { throw new TypeError('offline'); } })).failure.kind, 'network');
  const post = (body, type = 'application/json') => handler(new Request(transport.endpoint, { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': type }, body }));
  assert.equal((await post(JSON.stringify({ ...command, venue: { ...command.venue, latitude: 15 } }))).status, 400, 'pins are not owner fields');
  assert.equal((await post(JSON.stringify({ ...command, actor_user_id: VENUE }))).status, 400);
  assert.equal((await post('x'.repeat(40 * 1024))).status, 413);
  assert.equal((await post('name=x', 'text/plain')).status, 415);
  assert.equal((await handler(new Request(transport.endpoint, { method: 'DELETE', headers: { authorization: 'Bearer owner-token' } }))).status, 405);
  assert.equal((await handler(new Request(`${transport.endpoint}?venue_id=${VENUE}&extra=1`, { headers: { authorization: 'Bearer owner-token' } }))).status, 400);
  assert.equal(seen.save.length, 0, 'invalid input never reaches the database');
  const odd = await loadOwnedVenue({ ...transport, fetch: async () => new Response(JSON.stringify({ venue: listing({ photos: [{ ...photo, storage_path: 'elsewhere/x.jpg' }] }) })) }, VENUE);
  assert.equal(odd.failure.kind, 'unavailable', 'unexpected shapes are never shown as data');
});

test('photo uploads are sanitized, stored under a server-chosen name and cleaned up when not kept', async () => {
  const { transport, seen } = server();
  const added = await addVenuePhoto(transport, { venue_id: VENUE, request_id: REQUEST }, picked);
  assert.ok(added.ok); assert.equal(added.value.photos.length, 1);
  assert.equal(seen.uploaded.length, 1);
  const upload = seen.uploaded[0];
  assert.equal(upload.path, `${VENUE}/${NEW_ID}.jpg`, 'object name is chosen by the server');
  assert.equal(upload.type, 'image/jpeg');
  assert.ok(!upload.bytes.includes('GPS') && !upload.bytes.includes('secret'), 'metadata stripped before storage');
  assert.deepEqual([seen.added[0].width, seen.added[0].height], [480, 640], 'server-measured display dimensions');
  assert.deepEqual(plain(seen.added[0].request), { venue_id: VENUE, request_id: REQUEST });
  assert.deepEqual(seen.removed, []);

  const retry = server({ addPhoto: async () => ({ outcome: 'existing', venue: listing({ photos: [photo] }) }) });
  assert.ok((await addVenuePhoto(retry.transport, { venue_id: VENUE, request_id: REQUEST }, picked)).ok);
  assert.deepEqual(retry.seen.removed, [`${VENUE}/${NEW_ID}.jpg`], 'a retry keeps the original object only');
  const lost = server({ addPhoto: async () => { throw new CommandRejected('too_many_photos'); } });
  assert.equal((await addVenuePhoto(lost.transport, { venue_id: VENUE, request_id: REQUEST }, picked)).failure.reason, 'too_many_photos');
  assert.deepEqual(lost.seen.removed, [`${VENUE}/${NEW_ID}.jpg`], 'rejected uploads are removed');
  const crashed = server({ addPhoto: async () => { throw new Error('db down'); } });
  assert.equal((await addVenuePhoto(crashed.transport, { venue_id: VENUE, request_id: REQUEST }, picked)).failure.kind, 'unavailable');
  assert.equal(crashed.seen.removed.length, 0, 'a lost RPC reply may follow a commit; do not delete its photo');

  for (const [overrides, reason] of [[{ read: async () => { throw new CommandRejected('not_owner'); } }, 'not_owner']]) {
    const blocked = server(overrides);
    assert.equal((await addVenuePhoto(blocked.transport, { venue_id: VENUE, request_id: REQUEST }, picked)).failure.reason, reason);
    assert.equal(blocked.seen.uploaded.length, 0, `${reason}: nothing stored`);
  }
  const fullRetry = server({ read: async () => listing({ photos: Array.from({ length: 6 }, () => photo) }),
    addPhoto: async () => ({ outcome: 'existing', venue: listing({ photos: Array.from({ length: 6 }, () => photo) }) }) });
  assert.ok((await addVenuePhoto(fullRetry.transport, { venue_id: VENUE, request_id: REQUEST }, picked)).ok,
    'the sixth successful upload can be retried even though the gallery is full');
  for (const [file, reason] of [[new Uint8Array(Buffer.from('GIF89a........')), 'unsupported_photo'], [jpeg(200, 200), 'photo_dimensions'],
    [new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 3]), 'invalid_photo']]) {
    const refused = server({}, file);
    const result = await addVenuePhoto(refused.transport, { venue_id: VENUE, request_id: REQUEST }, picked);
    assert.equal(result.failure.reason, reason);
    assert.equal(refused.seen.uploaded.length + refused.seen.reads, 0, `${reason}: refused before any read or storage`);
  }

  const removal = server();
  const removed = await removeVenuePhoto(removal.transport, { venue_id: VENUE, photo_id: PHOTO });
  assert.ok(removed.ok); assert.deepEqual(removal.seen.removed, [photo.storage_path], 'the removed photo’s object is deleted');
  const noop = server({ removePhoto: async () => ({ removed_path: null, venue: listing() }) });
  assert.ok((await removeVenuePhoto(noop.transport, { venue_id: VENUE, photo_id: PHOTO })).ok);
  assert.deepEqual(noop.seen.removed, []);
});

test('editor helpers keep saved courts, explain blocked venues and precheck photos', () => {
  const venue = listing({ courts: [court, { ...court, id: 'c5000000-0000-4000-8000-000000000002', name: 'Court 3' }] });
  let draft = editor.addCourt(editor.draftFrom(venue), 'k1');
  assert.equal(draft.courts.at(-1).name, 'Court 4', 'skips names already used');
  assert.equal(editor.isDirty(editor.draftFrom(venue), venue), false);
  draft = editor.removeNewCourt(editor.removeNewCourt(draft, 'k1'), COURT);
  assert.equal(draft.courts.length, 2, 'saved courts are never dropped, only new ones');
  const inactive = editor.updateCourt(editor.updateCourt(draft, COURT, { status: 'inactive' }), 'c5000000-0000-4000-8000-000000000002', { status: 'inactive' });
  assert.match(editor.saveCommand(inactive, venue).message, /at least one court active/);
  assert.match(editor.saveCommand(editor.updateCourt(draft, COURT, { name: 'Court 3' }), venue).message, /Two courts are named “Court 3”/);
  assert.match(editor.saveCommand({ ...draft, name: '   ' }, venue).message, /Enter the venue name/);
  assert.deepEqual(plain(editor.photoProblem({ uri: 'file:///a.HEIC', mimeType: 'image/heic' })), { problem: 'Choose a JPEG or PNG photo.' });
  assert.match(editor.photoProblem({ uri: 'file:///a.jpg', fileSize: 6 * 1024 * 1024 }).problem, /5 MB/);
  assert.match(editor.photoProblem({ uri: 'file:///a.png', width: 200, height: 900 }).problem, /320 pixels/);
  assert.deepEqual(plain(editor.photoProblem({ uri: 'file:///a.png', width: 1200, height: 900, fileSize: 1000 })), { type: 'image/png' });
  assert.equal(editor.summaryStatus({ editable: true, publication_status: 'approved' }).tone, 'success');
  assert.match(editor.summaryStatus({ editable: false, publication_status: 'draft' }).note, /once it’s published/);
  assert.match(editor.summaryStatus({ editable: false, publication_status: 'suspended' }).note, /suspended/);
});
