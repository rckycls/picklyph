/* global __dirname */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const {
  toUtcIso, toManilaDateTime, fromManilaDateTime, formatManilaDateTime, validateRentalWindow,
} = require('../src/booking.ts');

test('explicit-offset timestamps normalize to UTC and preserve milliseconds', () => {
  const expected = '2026-10-05T16:30:45.123Z';
  assert.equal(toUtcIso('2026-10-06T00:30:45.123+08:00'), expected);
  assert.equal(toUtcIso('2026-10-05T12:30:45.123-04:00'), expected);
  assert.equal(toUtcIso(new Date(expected)), expected);
  assert.equal(toUtcIso(Date.parse(expected)), expected);
  assert.equal(toUtcIso('2024-02-29T12:00:00Z'), '2024-02-29T12:00:00.000Z');
});

test('ambiguous, impossible and unsupported precision inputs are rejected', () => {
  for (const input of [
    '2026-10-06', '2026-10-06T08:00:00', '10/06/2026', '2026-02-29T08:00:00Z',
    '2024-02-30T08:00:00Z', '2026-13-01T08:00:00Z', '2026-10-06T24:00:00Z',
    '2026-10-06T08:60:00Z', '2026-10-06T08:00:60Z', '2026-10-06T08:00:00+24:00',
    '2026-10-06T08:00:00+08:60', '2026-10-06T08:00:00.123456Z',
    '', 'garbage', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER, new Date(NaN),
  ]) assert.throws(() => toUtcIso(input), RangeError);
});

test('Manila display and wall-clock conversion cross UTC day/month/year boundaries', () => {
  for (const [utc, local] of [
    ['2026-10-05T15:59:00Z', { date: '2026-10-05', time: '23:59' }],
    ['2026-10-05T16:00:00Z', { date: '2026-10-06', time: '00:00' }],
    ['2026-12-31T16:00:00Z', { date: '2027-01-01', time: '00:00' }],
    ['2024-02-28T16:00:00Z', { date: '2024-02-29', time: '00:00' }],
    ['2024-02-29T16:00:00Z', { date: '2024-03-01', time: '00:00' }],
  ]) {
    assert.deepEqual(toManilaDateTime(utc), local);
    assert.equal(fromManilaDateTime(local), toUtcIso(utc));
  }
  const display = formatManilaDateTime('2026-12-31T16:00:00Z');
  assert.match(display, /Jan/);
  assert.match(display, /2027/);
  assert.match(display, /12:00\s*AM/i);
});

test('Manila wall-clock input rejects rollovers, invalid clocks and historical dates', () => {
  for (const local of [
    { date: '2026-02-29', time: '08:00' }, { date: '2026-04-31', time: '08:00' },
    { date: '2026-10-06', time: '24:00' }, { date: '2026-10-06', time: '08:60' },
    { date: '2026-10-06', time: '8:00' }, { date: '2026-10-06', time: '08:00:01' },
    { date: '1990-06-01', time: '08:00' }, { date: '2026-1-06', time: '08:00' },
  ]) assert.throws(() => fromManilaDateTime(local), RangeError);
});

const now = Date.parse('2026-10-06T15:59:00Z');
const minute = 60_000;
const start = now + minute;
const rental = (startsAt = start, endsAt = start + 60 * minute, clock = now) => validateRentalWindow({ startsAt, endsAt, now: clock });

test('rentals require at least one hour and exact 30-minute duration increments', () => {
  for (const minutes of [60, 90, 120, 1440, 1470]) {
    assert.deepEqual(rental(start, start + minutes * minute), { ok: true, durationMinutes: minutes });
  }
  for (const duration of [-minute, 0, 30 * minute, 60 * minute - 1]) {
    assert.deepEqual(rental(start, start + duration), { ok: false, reason: 'minimum_duration' });
  }
  for (const duration of [60 * minute + 1, 61 * minute, 89 * minute, 90 * minute - 1]) {
    assert.deepEqual(rental(start, start + duration), { ok: false, reason: 'duration_increment' });
  }
  // Start slot alignment belongs to schedule validation, not the duration rule.
  assert.deepEqual(rental(start + 123, start + 60 * minute + 123), { ok: true, durationMinutes: 60 });
});

test('future start is strict and the rolling 60-day start horizon is inclusive', () => {
  for (const startsAt of [now - 1, now]) assert.deepEqual(rental(startsAt, startsAt + 60 * minute), { ok: false, reason: 'start_not_future' });
  assert.deepEqual(rental(now + 1, now + 1 + 60 * minute), { ok: true, durationMinutes: 60 });
  const cutoff = now + 60 * 24 * 60 * minute;
  for (const startsAt of [cutoff - 1, cutoff]) assert.deepEqual(rental(startsAt, startsAt + 60 * minute), { ok: true, durationMinutes: 60 });
  assert.deepEqual(rental(cutoff + 1, cutoff + 1 + 60 * minute), { ok: false, reason: 'outside_horizon' });
});

test('equivalent offset instants yield the same rental result and invalid clocks fail closed', () => {
  assert.deepEqual(validateRentalWindow({
    now: '2026-12-31T15:59:00Z', startsAt: '2027-01-01T00:00:00+08:00', endsAt: '2026-12-31T17:30:00Z',
  }), { ok: true, durationMinutes: 90 });
  for (const field of ['startsAt', 'endsAt', 'now']) {
    assert.deepEqual(validateRentalWindow({ startsAt: start, endsAt: start + 60 * minute, now, [field]: '2026-10-06T08:00:00' }), { ok: false, reason: 'invalid_time' });
  }
});

test('conversion, display and horizon outcomes do not depend on the host timezone', () => {
  const source = `const b = require('./packages/domain/src/booking.ts');
    const now = Date.parse('2026-12-31T15:59:00Z');
    console.log(JSON.stringify([
      b.fromManilaDateTime({date:'2027-01-01',time:'00:00'}),
      b.toManilaDateTime('2026-12-31T16:00:00Z'), b.formatManilaDateTime('2026-12-31T16:00:00Z'),
      b.validateRentalWindow({now,startsAt:now+60*86400000,endsAt:now+60*86400000+3600000})
    ]));`;
  const cwd = require('node:path').resolve(__dirname, '../../..');
  const outputs = ['UTC', 'America/New_York', 'Asia/Tokyo'].map((TZ) => execFileSync(process.execPath, ['-e', source], { cwd, env: { ...process.env, TZ }, encoding: 'utf8' }).trim());
  assert.equal(outputs[0], outputs[1]);
  assert.equal(outputs[1], outputs[2]);
});
