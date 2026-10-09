const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');

const here = path.dirname(module.filename);
const dates = load(path.join(here, '../../../components/calendar/dates.ts'), {}, { Intl });
const agenda = load(path.join(here, '../agenda.ts'), { '@/components/calendar/dates': dates });
const plain = (value) => JSON.parse(JSON.stringify(value));

const VENUE = 'b9000000-0000-4000-8000-000000000001';
const COURT = 'c9000000-0000-4000-8000-000000000001';
const iso = (manila) => new Date(`${manila}+08:00`).toISOString();
const rental = (id, status, from, to) => ({ id, status, allocation: { venue_id: VENUE, court_id: COURT },
  snapshot: { starts_at: iso(from), ends_at: iso(to), total_centavos: 80000 } });
const group = (id, status, from, to) => ({ id, status, spots: 3,
  snapshot: { venue_id: VENUE, court_ids: [COURT], title: 'Sunset open play', starts_at: iso(from), ends_at: iso(to), total_centavos: 75000 } });

const rentals = [rental('r-late', 'confirmed', '2026-10-11T22:30:00', '2026-10-12T00:30:00'), rental('r-gone', 'cancelled', '2026-10-10T08:00:00', '2026-10-10T09:00:00'),
  rental('r-past', 'confirmed', '2026-10-08T06:00:00', '2026-10-08T07:00:00')];
const groups = [group('g-pending', 'pending', '2026-10-10T18:00:00', '2026-10-10T20:00:00')];

test('rentals and groups merge into one start-ordered list of Manila days and minutes', () => {
  const entries = agenda.playerEntries(rentals, groups);
  assert.deepEqual(plain(entries.map((e) => e.id)), ['r-past', 'r-gone', 'g-pending', 'r-late']);
  const late = entries.find((e) => e.id === 'r-late');
  assert.deepEqual(plain({ date: late.date, start: late.start, end: late.end, duration: late.durationMinutes }), { date: '2026-10-11', start: 1350, end: 1470, duration: 120 });
  const play = entries.find((e) => e.id === 'g-pending');
  assert.deepEqual(plain({ kind: play.kind, title: play.title, spots: play.spots, courts: play.courtIds, total: play.totalCentavos }),
    { kind: 'group', title: 'Sunset open play', spots: 3, courts: [COURT], total: 75000 });
});

test('dots mark days with live bookings; pending requests need attention; cancelled ones never show', () => {
  const marks = agenda.playerMarks(agenda.playerEntries(rentals, [...groups, group('g-ok', 'confirmed', '2026-10-10T07:00:00', '2026-10-10T08:00:00')]));
  assert.deepEqual(plain(Object.fromEntries(marks)), { '2026-10-08': 'busy', '2026-10-10': 'attention', '2026-10-11': 'busy' });
});

test('coming up lists live bookings that have not ended, soonest first', () => {
  const entries = agenda.playerEntries(rentals, groups);
  const now = Date.parse(iso('2026-10-10T19:00:00'));
  assert.deepEqual(plain(agenda.upcoming(entries, now, 5).map((e) => e.id)), ['g-pending', 'r-late']);
  assert.deepEqual(plain(agenda.upcoming(entries, now, 1).map((e) => e.id)), ['g-pending']);
  assert.deepEqual(plain(agenda.upcoming(entries, Date.parse(iso('2026-10-10T20:00:00')), 5).map((e) => e.id)), ['r-late']);
});
