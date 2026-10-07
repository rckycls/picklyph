/* global __dirname */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { readCourtHours, readCourtHoursSave, readCalendarQuery, readScheduleCommand, resolveCourtHours, courtDayRanges } = require('../src/calendar.ts');
const { resolveVenueSchedule } = require('../src/schedule.ts');

const VENUE = '62000000-0000-4000-8000-000000000001';
const COURT = 'A3000000-0000-4000-8000-000000000001';
const REQUEST = '74000000-0000-4000-8000-000000000001';
const every = (windows) => Array.from({ length: 7 }, () => windows);
const w = (start_minute, end_minute) => ({ start_minute, end_minute });
// Monday 22:00-02:00 (rate changes at midnight), Tuesday 08:00-12:00; 2026-10-05 is a Monday.
const venue = { weekly: [[], [{ start_minute: 1320, end_minute: 1560, rates: [{ start_minute: 1320, end_minute: 1440, hourly_centavos: 25000 },
  { start_minute: 1440, end_minute: 1560, hourly_centavos: 30000 }] }], [{ start_minute: 480, end_minute: 720, rates: [{ start_minute: 480, end_minute: 720, hourly_centavos: 40000 }] }],
  [], [], [], []], exceptions: [] };

test('court hours mirror SQL: same-day sorted windows, at most four per day, unique bounded closures', () => {
  assert.deepEqual(readCourtHours({ weekly: null, closures: ['2026-10-12', '2026-10-06'] }), { weekly: null, closures: ['2026-10-06', '2026-10-12'] });
  assert.deepEqual(readCourtHours({ weekly: every([w(0, 60), w(60, 120), w(1380, 1440)]), closures: [] }).weekly[3], [w(0, 60), w(60, 120), w(1380, 1440)]);
  for (const bad of [
    { weekly: null }, { weekly: null, closures: [], actor_user_id: VENUE }, { weekly: [], closures: [] }, { weekly: {}, closures: [] },
    { weekly: every([w(480, 480)]), closures: [] }, { weekly: every([w(480, 1470)]), closures: [] }, { weekly: every([w(1440, 1470)]), closures: [] },
    { weekly: every([w(495, 600)]), closures: [] }, { weekly: every([w(480, 720), w(690, 900)]), closures: [] },
    { weekly: every([w(600, 720), w(480, 540)]), closures: [] }, { weekly: every([{ ...w(480, 720), rates: [] }]), closures: [] },
    { weekly: every([w(0, 30), w(60, 90), w(120, 150), w(180, 210), w(240, 270)]), closures: [] },
    { weekly: null, closures: ['2026-02-30'] }, { weekly: null, closures: ['1999-12-31'] }, { weekly: null, closures: [20261012] },
    { weekly: null, closures: ['2026-10-12', '2026-10-12'] },
    { weekly: null, closures: Array.from({ length: 121 }, (_, i) => new Date(Date.UTC(2030, 0, 1 + i)).toISOString().slice(0, 10)) },
  ]) assert.throws(() => readCourtHours(bad), { name: 'CalendarInputError' });
  assert.deepEqual(readCourtHoursSave({ court_id: COURT, expected_revision: '3', hours: { weekly: null, closures: [] } }).court_id, COURT.toLowerCase());
  for (const revision of ['0', '01', 3, '12345678901234567']) assert.throws(() => readCourtHoursSave({ court_id: COURT, expected_revision: revision, hours: { weekly: null, closures: [] } }));
});

test('owner-schedules commands dispatch strictly; the T19 body without kind stays a schedule save', () => {
  const save = { venue_id: VENUE, expected_revision: null, schedule: venue };
  assert.equal(readScheduleCommand(save).kind, 'save_schedule');
  assert.deepEqual(readScheduleCommand({ kind: 'block', court_id: COURT, request_id: REQUEST, starts_at: '2026-10-09T08:00:00+08:00', ends_at: '2026-10-09T09:30:00+08:00' }),
    { kind: 'block', command: { court_id: COURT.toLowerCase(), request_id: REQUEST, starts_at: '2026-10-09T00:00:00.000Z', ends_at: '2026-10-09T01:30:00.000Z' } });
  assert.deepEqual(readScheduleCommand({ kind: 'release_block', allocation_id: REQUEST }), { kind: 'release_block', command: { allocation_id: REQUEST } });
  assert.equal(readScheduleCommand({ kind: 'save_court_hours', court_id: COURT, expected_revision: null, hours: { weekly: null, closures: [] } }).command.expected_revision, null);
  for (const bad of [null, [], { kind: 'save_schedule', ...save }, { kind: 'nope' }, { kind: 'release_block' }, { kind: 'release_block', allocation_id: 'x' },
    { kind: 'release_block', allocation_id: REQUEST, actor_user_id: VENUE }, { kind: 'block', court_id: COURT, request_id: REQUEST, starts_at: '2026-10-09T08:00:00Z', ends_at: '2026-10-09T09:00:00Z', actor_user_id: VENUE },
    { kind: 'save_court_hours', court_id: COURT, expected_revision: null, hours: { weekly: null, closures: [] }, venue_id: VENUE }])
    assert.throws(() => readScheduleCommand(bad));
});

test('calendar queries are 1-7 Manila days with exact keys', () => {
  const params = (extra = {}) => new URLSearchParams({ venue_id: VENUE, start_date: '2026-10-09', days: '7', section: 'calendar', ...extra });
  assert.deepEqual(readCalendarQuery(params()), { venue_id: VENUE, start_date: '2026-10-09', days: 7 });
  for (const bad of [params({ days: '8' }), params({ days: '0' }), params({ days: '01' }), params({ section: 'hours' }), params({ start_date: '2026-02-30' }),
    params({ start_date: '2099-12-30', days: '3' }), params({ actor_user_id: VENUE }), new URLSearchParams({ venue_id: VENUE, start_date: '2026-10-09', days: '1' })])
    assert.throws(() => readCalendarQuery(bad), { name: 'CalendarInputError' });
});

test('court hours intersect venue intervals per Manila date, keep venue rates and close whole dates', () => {
  assert.deepEqual(resolveCourtHours(venue, { weekly: null, closures: [] }, '2026-10-05', 2), resolveVenueSchedule(venue, '2026-10-05', 2));
  const custom = { weekly: [[], [w(1380, 1440)], [w(0, 60), w(540, 600)], [], [], [], []], closures: [] };
  assert.deepEqual(resolveCourtHours(venue, custom, '2026-10-05', 2), [
    { starts_at: '2026-10-05T15:00:00.000Z', ends_at: '2026-10-05T16:00:00.000Z', hourly_centavos: 25000 },
    { starts_at: '2026-10-05T16:00:00.000Z', ends_at: '2026-10-05T17:00:00.000Z', hourly_centavos: 30000 },
    { starts_at: '2026-10-06T01:00:00.000Z', ends_at: '2026-10-06T02:00:00.000Z', hourly_centavos: 40000 },
  ]);
  // A closure removes the whole date, including the overnight spill into it.
  assert.deepEqual(resolveCourtHours(venue, { weekly: null, closures: ['2026-10-06'] }, '2026-10-05', 2), [
    { starts_at: '2026-10-05T14:00:00.000Z', ends_at: '2026-10-05T16:00:00.000Z', hourly_centavos: 25000 },
  ]);
  assert.deepEqual(resolveCourtHours(venue, { weekly: every([]), closures: [] }, '2026-10-05', 7), []);
  assert.deepEqual(courtDayRanges({ weekly: null, closures: [] }, '2026-10-05'), [w(0, 1440)]);
  assert.throws(() => resolveCourtHours(venue, { weekly: every([w(60, 30)]), closures: [] }, '2026-10-05', 1));
});

test('court resolution is independent of host timezone', () => {
  const code = `const {resolveCourtHours}=require('./packages/domain/src/calendar.ts');process.stdout.write(JSON.stringify(resolveCourtHours(${JSON.stringify(venue)},{weekly:[[],[{start_minute:1380,end_minute:1440}],[{start_minute:0,end_minute:60}],[],[],[],[]],closures:['2026-10-07']},'2026-10-05',3)));`;
  const outputs = ['UTC', 'America/New_York', 'Asia/Tokyo'].map((TZ) => execFileSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '../../..'), env: { ...process.env, TZ }, encoding: 'utf8' }));
  assert.equal(outputs[0], outputs[1]); assert.equal(outputs[0], outputs[2]);
  assert.equal(JSON.parse(outputs[0]).length, 2);
});
