const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');

const here = path.dirname(module.filename);
const root = path.resolve(here, '../../../..');
const domain = { ...require(path.join(root, 'packages/domain/src/booking.ts')), ...require(path.join(root, 'packages/domain/src/money.ts')),
  ...require(path.join(root, 'packages/domain/src/schedule.ts')), ...require(path.join(root, 'packages/domain/src/allocation.ts')),
  ...require(path.join(root, 'packages/domain/src/calendar.ts')) };
const imports = { '@picklyph/domain': domain };
const model = load(path.join(here, '../calendarModel.ts'), imports, { Intl });
const hours = load(path.join(here, '../hoursDraft.ts'), imports);
const client = load(path.join(here, '../calendarClient.ts'), { ...imports, './venueClient': require('../venueClient.ts') });
const { createScheduleHandler, ScheduleRejected } = load(path.join(root, 'supabase/functions/owner-schedules/handler.ts'), {}, { TextDecoder });

const plain = (value) => JSON.parse(JSON.stringify(value));
const VENUE = 'b6000000-0000-4000-8000-000000000001';
const COURT = 'c6000000-0000-4000-8000-000000000001';
const OTHER = 'c6000000-0000-4000-8000-000000000002';
const REQUEST = 'f6000000-0000-4000-8000-000000000001';
// 2026-10-09 (Friday) in Manila; UTC is 8 hours behind.
const iso = (manila) => new Date(`${manila}+08:00`).toISOString();
const allocation = (id, court, kind, from, to, extra = {}) => ({ id, venue_id: VENUE, court_id: court, kind, starts_at: iso(from), ends_at: iso(to),
  expires_at: null, state: 'active', ended_at: null, ...extra });
const calendar = (overrides = {}) => ({
  venue_id: VENUE, name: 'Alpha Courts', start_date: '2026-10-09', days: 1, at: iso('2026-10-09T09:10:00'), schedule_revision: '3',
  courts: [
    { court_id: COURT, revision: '2', name: 'Court 1', status: 'active', hours: { weekly: null, closures: [] }, intervals: [
      { starts_at: iso('2026-10-09T06:00:00'), ends_at: iso('2026-10-09T17:00:00'), hourly_centavos: 40000 },
      { starts_at: iso('2026-10-09T17:00:00'), ends_at: iso('2026-10-10T00:00:00'), hourly_centavos: 60000 }] },
    { court_id: OTHER, revision: null, name: 'Court 2', status: 'inactive', hours: { weekly: null, closures: ['2026-10-09'] }, intervals: [] }],
  allocations: [
    allocation('a6000000-0000-4000-8000-000000000001', COURT, 'block', '2026-10-08T23:00:00', '2026-10-09T07:00:00'),
    allocation('a6000000-0000-4000-8000-000000000002', COURT, 'rental', '2026-10-09T12:00:00', '2026-10-09T13:30:00', { expires_at: iso('2026-10-09T09:25:00') }),
    allocation('a6000000-0000-4000-8000-000000000003', COURT, 'session', '2026-10-09T22:00:00', '2026-10-10T01:00:00')],
  ...overrides,
});

test('court day: merged Manila hours, labelled inventory, cross-day flags and free time after the server clock', () => {
  const view = client.parseCalendar(calendar(), VENUE);
  const day = model.courtDay(view, COURT, '2026-10-09');
  assert.deepEqual(plain(day.open), [{ start: 360, end: 1440 }]);
  assert.deepEqual(plain(day.items.map(({ start, end, label, fromPreviousDay, toNextDay, heldUntil, releasable }) => ({ start, end, label, fromPreviousDay, toNextDay, heldUntil, releasable }))), [
    { start: 0, end: 420, label: 'Blocked', fromPreviousDay: true, toNextDay: false, heldUntil: null, releasable: true },
    { start: 720, end: 810, label: 'Court rental', fromPreviousDay: false, toNextDay: false, heldUntil: '9:25 AM', releasable: false },
    { start: 1320, end: 1440, label: 'Open play', fromPreviousDay: false, toNextDay: true, heldUntil: null, releasable: false }]);
  // 09:10 now: the first start is 09:30; booked/blocked/held time is excluded.
  assert.deepEqual(plain(day.free), [{ start: 570, end: 720 }, { start: 810, end: 1320 }]);
  assert.equal(model.startOptions(day.free)[0], 570);
  assert.deepEqual(plain(model.endOptions(day.free, 630)), [660, 690, 720]);
  assert.deepEqual(plain(model.endOptions(day.free, 700)), []);
  assert.equal(day.closedReason, null);
  const closed = model.courtDay(view, OTHER, '2026-10-09');
  assert.equal(closed.closedReason, 'closure'); assert.equal(closed.active, false); assert.deepEqual(plain(closed.free), []);
  // Intervals and inventory from another date never leak into this day.
  assert.deepEqual(plain(model.courtDay(client.parseCalendar(calendar({ start_date: '2026-10-10', allocations: [] }), VENUE), COURT, '2026-10-10').open), []);
});

test('block commands, clock labels and dates use Manila wall time', () => {
  assert.deepEqual(plain(model.blockCommand(COURT, '2026-10-09', { start: 1380, end: 1440 }, REQUEST)),
    { court_id: COURT, request_id: REQUEST, starts_at: '2026-10-09T15:00:00.000Z', ends_at: '2026-10-09T16:00:00.000Z' });
  assert.equal(model.clockLabel(0), '12:00 AM'); assert.equal(model.clockLabel(750), '12:30 PM'); assert.equal(model.clockLabel(1440), 'midnight');
  assert.equal(model.clockLabel(1560), '2:00 AM (next day)');
  assert.equal(model.manilaDate('2026-10-09T16:30:00Z'), '2026-10-10');
  assert.equal(model.addDays('2026-12-31', 1), '2027-01-01');
  assert.match(model.dayTitle('2026-10-09'), /Friday/);
});

test('venue hours draft groups touching stretches, keeps rates exact and reports owner-facing problems', () => {
  const schedule = { weekly: [[], [{ start_minute: 1320, end_minute: 1560, rates: [{ start_minute: 1320, end_minute: 1440, hourly_centavos: 25050 },
    { start_minute: 1440, end_minute: 1560, hourly_centavos: 30000 }] }], [], [], [], [], []],
    exceptions: [{ date: '2026-10-01', windows: [] }, { date: '2026-10-20', windows: [] }, { date: '2026-10-21', windows: [{ start_minute: 600, end_minute: 660, rates: [{ start_minute: 600, end_minute: 660, hourly_centavos: 1 }] }] }] };
  const draft = hours.scheduleDraftFrom(schedule);
  assert.deepEqual(plain(draft.weekly[1]), [{ start: 1320, end: 1440, pesos: '250.50' }, { start: 1440, end: 1560, pesos: '300' }]);
  assert.deepEqual(plain(draft.closures), ['2026-10-01', '2026-10-20']);
  // Past closures are dropped; special hours stay untouched.
  assert.deepEqual(plain(hours.scheduleFromDraft(draft, '2026-10-09')), { ...schedule, exceptions: schedule.exceptions.slice(1) });
  const closed = hours.toggleClosure(draft, '2026-10-21');
  assert.deepEqual(plain(closed.special), []); assert.deepEqual(plain(hours.toggleClosure(closed, '2026-10-21').closures), ['2026-10-01', '2026-10-20']);
  // Copying Monday's overnight hours everywhere fits; an early Tuesday stretch under Monday's spill doesn't.
  assert.equal(hours.scheduleFromDraft(hours.copyDayToAll(draft, 1), '2026-10-09').weekly[4][0].end_minute, 1560);
  assert.throws(() => hours.scheduleFromDraft({ ...draft, weekly: draft.weekly.map((b, i) => (i === 2 ? [{ start: 60, end: 180, pesos: '1' }] : b)) }, '2026-10-09'), /overlap the next day/);
  const edit = (bands) => ({ ...draft, weekly: draft.weekly.map((b, i) => (i === 3 ? bands : b)) });
  for (const [bands, message] of [[[{ start: 600, end: 600, pesos: '1' }], /after its opening/], [[{ start: 600, end: 660, pesos: '4.005' }], /hourly rate/],
    [[{ start: 600, end: 720, pesos: '1' }, { start: 660, end: 780, pesos: '1' }], /overlap/],
    [[0, 120, 240, 360, 480].map((start) => ({ start, end: start + 60, pesos: '1' })), /at most 4/]])
    assert.throws(() => hours.scheduleFromDraft(edit(bands), '2026-10-09'), message);
  assert.deepEqual(plain(hours.addBand([])), [{ start: 480, end: 1320, pesos: '' }]);
  assert.deepEqual(plain(hours.addBand([{ start: 480, end: 1320, pesos: '400' }])[1]), { start: 1320, end: 1380, pesos: '400' });
  assert.equal(hours.addBand(draft.weekly[1]).length, 2);
  assert.equal(hours.closureDateOptions('2026-12-31')[1], '2027-01-01');
});

test('court hours draft: venue-following or own same-day periods, closures from today', () => {
  const draft = hours.courtDraftFrom({ weekly: null, closures: ['2026-10-01', '2026-10-12'] });
  assert.equal(draft.custom, false);
  assert.deepEqual(plain(hours.courtHoursFromDraft(draft, '2026-10-09')), { weekly: null, closures: ['2026-10-12'] });
  const custom = { ...draft, custom: true };
  assert.deepEqual(plain(hours.courtHoursFromDraft(custom, '2026-10-09').weekly[0]), [{ start_minute: 480, end_minute: 1320 }]);
  assert.throws(() => hours.courtHoursFromDraft({ ...custom, weekly: custom.weekly.map(() => [{ start_minute: 600, end_minute: 720 }, { start_minute: 660, end_minute: 780 }]) }, '2026-10-09'), /overlap/);
  assert.deepEqual(plain(hours.addCourtWindow([{ start_minute: 480, end_minute: 720 }])), [{ start_minute: 480, end_minute: 720 }, { start_minute: 750, end_minute: 810 }]);
  assert.equal(hours.addCourtWindow([{ start_minute: 480, end_minute: 1410 }]).length, 1);
});

test('shipped client against the real handler: verified actor, retry-safe blocks, strict replies and mapped refusals', async () => {
  const blocks = new Map(); const seen = []; let limit = { allowed: true, headers: {} };
  const handler = createScheduleHandler({
    verifyUser: async (token) => (token === 'real' ? 'verified-actor' : null),
    limit: async (action) => { seen.push(action); return limit; },
    read: async () => { throw new Error('unused'); }, save: async () => { throw new ScheduleRejected('hours_conflict'); },
    calendar: async (actor, venue, date, days) => { seen.push([actor, venue, date, days]); return calendar(); },
    block: async (actor, command) => {
      assert.equal(actor, 'verified-actor');
      if (command.starts_at === '2026-10-09T04:00:00.000Z') throw new ScheduleRejected('allocation_conflict');
      const existing = blocks.get(command.request_id);
      const result = { outcome: existing ? 'existing' : 'created', allocation: allocation('a6000000-0000-4000-8000-000000000009', command.court_id, 'block', '2026-10-09T10:00:00', '2026-10-09T11:00:00') };
      blocks.set(command.request_id, result); return result;
    },
    release: async () => { throw new ScheduleRejected('managed_allocation'); },
    saveCourtHours: async (actor, command) => ({ court_id: command.court_id, revision: '1', hours: command.hours }),
  });
  const transport = { endpoint: 'https://local/owner-schedules', apiKey: 'public', accessToken: async () => 'real', fetch: (url, init) => handler(new Request(url, init)) };
  const loaded = await client.loadCalendar(transport, VENUE, '2026-10-09', 1);
  assert.equal(loaded.ok, true); assert.equal(loaded.value.courts.length, 2);
  assert.deepEqual(plain(seen.slice(0, 2)), ['owner-read', ['verified-actor', VENUE, '2026-10-09', 1]]);
  const command = model.blockCommand(COURT, '2026-10-09', { start: 600, end: 660 }, REQUEST);
  assert.equal((await client.blockCourt(transport, command)).value.outcome, 'created');
  assert.equal((await client.blockCourt(transport, command)).value.outcome, 'existing');
  assert.equal(blocks.size, 1);
  const conflict = await client.blockCourt(transport, model.blockCommand(COURT, '2026-10-09', { start: 720, end: 780 }, REQUEST));
  assert.equal(conflict.failure.reason, 'allocation_conflict'); assert.match(client.calendarFailureMessage(conflict.failure), /already has part of that time/);
  assert.equal((await client.releaseBlock(transport, REQUEST)).failure.reason, 'managed_allocation');
  const saved = await client.saveCourtHours(transport, { court_id: COURT, expected_revision: null, hours: { weekly: null, closures: ['2026-10-12'] } });
  assert.deepEqual(plain(saved.value.hours), { weekly: null, closures: ['2026-10-12'] });
  const displaced = await client.saveVenueSchedule(transport, { venue_id: VENUE, expected_revision: '3', schedule: { weekly: Array.from({ length: 7 }, () => []), exceptions: [] } });
  assert.equal(displaced.failure.reason, 'hours_conflict');
  limit = { allowed: false, status: 429, headers: { 'Retry-After': '17' } };
  assert.deepEqual(plain((await client.blockCourt(transport, command)).failure), { kind: 'rate_limited', retryAfterSeconds: 17 });
  limit = { allowed: false, status: 503, headers: { 'Retry-After': '5' } };
  assert.equal((await client.blockCourt(transport, command)).failure.kind, 'unavailable');
  limit = { allowed: true, headers: {} };
  // Spoofed authority never reaches a command; a malformed reply is never shown as data.
  const spoof = await handler(new Request(transport.endpoint, { method: 'POST', headers: { authorization: 'Bearer real', 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'block', ...command, actor_user_id: VENUE }) }));
  assert.equal(spoof.status, 400);
  const broken = { ...transport, fetch: async () => new Response(JSON.stringify({ ...calendar(), venue_id: COURT }), { status: 200 }) };
  assert.equal((await client.loadCalendar(broken, VENUE, '2026-10-09', 1)).failure.kind, 'unavailable');
  assert.equal((await client.loadCalendar({ ...transport, accessToken: async () => null }, VENUE, '2026-10-09', 1)).failure.kind, 'sign_in');
  for (const reason of ['not_owner', 'outside_hours', 'hours_conflict', 'version_conflict', 'court_unavailable', 'invalid_request'])
    assert.ok(client.calendarFailureMessage({ kind: 'rejected', reason, retryAfterSeconds: null }).length > 20);
});
