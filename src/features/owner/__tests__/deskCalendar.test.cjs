const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');

const here = path.dirname(module.filename);
const dates = load(path.join(here, '../../../components/calendar/dates.ts'), {}, { Intl });
const desk = load(path.join(here, '../deskCalendar.ts'), { '@/components/calendar/dates': dates });
const plain = (value) => JSON.parse(JSON.stringify(value));

const C1 = 'c8000000-0000-4000-8000-000000000001';
const C2 = 'c8000000-0000-4000-8000-000000000002';
const SESSION = 'e8000000-0000-4000-8000-000000000001';
const iso = (manila) => new Date(`${manila}+08:00`).toISOString();
const ops = (attendance = 'none', payment = null) => ({ attendance, attendance_at: attendance === 'none' ? null : iso('2026-10-10T10:00:00'), payment });
const rental = (id, court, from, to, operations = ops(), total = 80000) => ({ kind: 'rental',
  booking: { id, allocation: { court_id: court, starts_at: iso(from), ends_at: iso(to) }, operations, snapshot: { total_centavos: total } } });
const group = (id, operations = ops(), spots = 2) => ({ kind: 'group', booking: { id, session_id: SESSION, spots, operations,
  snapshot: { court_ids: [C1, C2], starts_at: iso('2026-10-10T18:00:00'), ends_at: iso('2026-10-10T20:00:00'), total_centavos: 25000 * spots } } });
const paid = (amount) => ({ method: 'cash', amount_centavos: amount, recorded_at: iso('2026-10-10T10:05:00') });

test('desk entries: rentals on their court, each session once across its courts, late rentals flagged into the next day', () => {
  const entries = desk.deskEntries('2026-10-10', [
    rental('r2', C2, '2026-10-10T23:00:00', '2026-10-11T01:00:00'), group('g1'), rental('r1', C1, '2026-10-10T10:00:00', '2026-10-10T11:00:00'), group('g2')]);
  assert.deepEqual(plain(entries.map((e) => ({ kind: e.kind, key: e.key, courts: e.courtIds, start: e.start, end: e.end, before: e.continuesBefore, after: e.continuesAfter,
    items: e.items.map((item) => item.booking.id) }))), [
    { kind: 'rental', key: 'r1', courts: [C1], start: 600, end: 660, before: false, after: false, items: ['r1'] },
    { kind: 'session', key: SESSION, courts: [C1, C2], start: 1080, end: 1200, before: false, after: false, items: ['g1', 'g2'] },
    { kind: 'rental', key: 'r2', courts: [C2], start: 1380, end: 1440, before: false, after: true, items: ['r2'] },
  ]);
});

test('entry tone turns green once everyone arrived and grey when all were no-shows', () => {
  const tone = (items) => desk.entryTone(desk.deskEntries('2026-10-10', items)[0]);
  assert.equal(tone([rental('r', C1, '2026-10-10T10:00:00', '2026-10-10T11:00:00')]), 'rental');
  assert.equal(tone([rental('r', C1, '2026-10-10T10:00:00', '2026-10-10T11:00:00', ops('completed'))]), 'done');
  assert.equal(tone([rental('r', C1, '2026-10-10T10:00:00', '2026-10-10T11:00:00', ops('no_show'))]), 'muted');
  assert.equal(tone([group('a', ops('checked_in')), group('b')]), 'session');
  assert.equal(tone([group('a', ops('checked_in')), group('b', ops('completed'))]), 'done');
});

test('desk summary counts arrivals, money recorded and money still due (never for no-shows)', () => {
  assert.deepEqual(plain(desk.deskSummary([
    rental('r1', C1, '2026-10-10T10:00:00', '2026-10-10T11:00:00', ops('checked_in', paid(80000))),
    rental('r2', C2, '2026-10-10T12:00:00', '2026-10-10T13:00:00'),
    group('g1', ops('no_show')), group('g2', ops('completed'), 3),
  ])), { bookings: 4, arrived: 2, paidCentavos: 80000, dueCentavos: 80000 + 75000 });
  assert.deepEqual(plain(desk.deskSummary([])), { bookings: 0, arrived: 0, paidCentavos: 0, dueCentavos: 0 });
});
