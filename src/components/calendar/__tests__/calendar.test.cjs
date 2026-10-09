const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');

const here = path.dirname(module.filename);
const dates = load(path.join(here, '../dates.ts'), {}, { Intl });
const timeline = load(path.join(here, '../timeline.ts'));
const plain = (value) => JSON.parse(JSON.stringify(value));

test('weeks run Monday to Sunday and months cover whole weeks, independent of the host time zone', () => {
  // 2026-10-09 is a Friday.
  assert.equal(dates.startOfWeek('2026-10-09'), '2026-10-05');
  assert.equal(dates.startOfWeek('2026-10-05'), '2026-10-05');
  assert.equal(dates.startOfWeek('2026-10-11'), '2026-10-05');
  assert.deepEqual(plain(dates.weekOf('2026-10-11')), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  const october = dates.monthWeeks('2026-10-15');
  assert.equal(october.length, 5);
  assert.equal(october[0][0], '2026-09-28');
  assert.equal(october[4][6], '2026-11-01');
  // February 2027 starts on a Monday and fills exactly four weeks.
  assert.deepEqual(plain(dates.monthWeeks('2027-02-10').map((week) => week[0])), ['2027-02-01', '2027-02-08', '2027-02-15', '2027-02-22']);
  assert.equal(dates.shiftMonths('2026-01-31', 1), '2026-02-01');
  assert.equal(dates.shiftMonths('2026-12-15', 1), '2027-01-01');
  assert.equal(dates.shiftMonths('2026-01-10', -1), '2025-12-01');
  assert.equal(dates.shiftDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dates.shiftDays('2028-03-01', -1), '2028-02-29');
  assert.equal(dates.daysBetween('2026-10-05', '2026-10-11'), 6);
  assert.equal(dates.clampDate('1999-12-31'), '2000-01-01');
  assert.equal(dates.clampDate('2100-01-01'), '2099-12-31');
  assert.ok(dates.sameMonth('2026-10-01', '2026-10-31') && !dates.sameMonth('2026-10-31', '2026-11-01'));
  assert.equal(dates.dayOfMonth('2026-10-09'), 9);
});

test('instants map to Manila dates and minutes with the fixed UTC+8 offset', () => {
  assert.deepEqual(plain(dates.manilaParts('2026-10-08T16:30:00Z')), { date: '2026-10-09', minute: 30 });
  assert.deepEqual(plain(dates.manilaParts('2026-10-09T15:59:00Z')), { date: '2026-10-09', minute: 1439 });
  assert.deepEqual(plain(dates.manilaParts(Date.parse('2026-10-09T16:00:00Z'))), { date: '2026-10-10', minute: 0 });
  assert.equal(dates.minutesFrom('2026-10-09', '2026-10-08T16:00:00Z'), 0);
  assert.equal(dates.minutesFrom('2026-10-09', '2026-10-08T15:00:00Z'), -60);
  assert.equal(dates.minutesFrom('2026-10-09', '2026-10-09T17:00:00Z'), 1500);
});

test('labels: clock times, gutter hours and English (Philippines) dates', () => {
  assert.deepEqual([0, 390, 720, 1439, 1440, 1500].map(dates.clockText), ['12:00 AM', '6:30 AM', '12:00 PM', '11:59 PM', '12:00 AM', '1:00 AM']);
  assert.deepEqual([0, 360, 720, 780].map(dates.hourText), ['12 AM', '6 AM', '12 PM', '1 PM']);
  assert.equal(dates.monthTitle('2026-10-09'), 'October 2026');
  assert.equal(dates.weekdayText('2026-10-09'), 'Fri');
  assert.equal(dates.shortDateText('2026-10-09'), 'Fri, Oct 9');
  assert.equal(dates.monthDayText('2026-10-09'), 'Oct 9');
  assert.equal(dates.longDateText('2026-10-09'), 'Friday, October 9, 2026');
  assert.deepEqual(plain(dates.WEEKDAY_HEADINGS), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});

test('timeline range covers whole hours, keeps a minimum height and stays inside the day', () => {
  const fallback = { start: 360, end: 1320 };
  assert.deepEqual(plain(timeline.timelineRange([], fallback)), fallback);
  assert.deepEqual(plain(timeline.timelineRange([{ start: 600, end: 600 }], fallback)), fallback);
  assert.deepEqual(plain(timeline.timelineRange([{ start: 390, end: 600 }, { start: 450, end: 540 }], fallback)), { start: 360, end: 600 });
  assert.deepEqual(plain(timeline.timelineRange([{ start: 420, end: 480 }], fallback)), { start: 420, end: 660 });
  assert.deepEqual(plain(timeline.timelineRange([{ start: 1380, end: 1440 }], fallback)), { start: 1200, end: 1440 });
  assert.deepEqual(plain(timeline.timelineRange([{ start: 0, end: 1440 }], fallback)), { start: 0, end: 1440 });
  assert.deepEqual(plain(timeline.hourMarks({ start: 360, end: 600 })), [360, 420, 480, 540, 600]);
});

test('taps snap down to 30-minute slots inside the range; spans clip to it', () => {
  const range = { start: 360, end: 600 };
  assert.equal(timeline.minuteAt(0, 56, range), 360);
  assert.equal(timeline.minuteAt(27.9, 56, range), 360);
  assert.equal(timeline.minuteAt(28, 56, range), 390);
  assert.equal(timeline.minuteAt(-5, 56, range), 360);
  assert.equal(timeline.minuteAt(10_000, 56, range), 570);
  assert.deepEqual(plain(timeline.frameOf({ start: 390, end: 450 }, range, 60)), { top: 30, height: 60 });
  assert.deepEqual(plain(timeline.frameOf({ start: 300, end: 420 }, range, 60)), { top: 0, height: 60 });
  assert.equal(timeline.frameOf({ start: 600, end: 660 }, range, 60), null);
});

test('overlapping items share lanes within their cluster only', () => {
  const lanes = timeline.assignLanes([{ id: 'c', start: 60, end: 120 }, { id: 'a', start: 0, end: 60 }, { id: 'b', start: 30, end: 90 }, { id: 'd', start: 130, end: 140 }]);
  const byId = Object.fromEntries(lanes.map((entry) => [entry.item.id, [entry.lane, entry.lanes]]));
  assert.deepEqual(byId, { a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] });
  assert.deepEqual(plain(timeline.assignLanes([{ start: 0, end: 30 }, { start: 30, end: 60 }]).map((entry) => [entry.lane, entry.lanes])), [[0, 1], [0, 1]]);
});
