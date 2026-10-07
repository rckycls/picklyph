const assert = require('node:assert/strict');
const { test } = require('node:test');
const { requireRentalWindow, priceRental } = require('../src/rental.ts');
const at = minute => new Date(Date.parse('2027-01-02T00:00:00+08:00') + minute * 60000).toISOString();
const band = (a, b, rate) => ({ starts_at: at(a), ends_at: at(b), hourly_centavos: rate });
const reason = (fn, value) => assert.throws(fn, error => error.reason === value);

test('rental feedback: authoritative-clock boundaries, alignment, duration and inventory date limits', () => {
  const rental = { startsAt: at(0), endsAt: at(60), now: at(-1) };
  assert.equal(requireRentalWindow(rental), 60);
  reason(() => requireRentalWindow({ ...rental, now: at(0) }), 'start_not_future');
  reason(() => requireRentalWindow({ ...rental, endsAt: at(30) }), 'minimum_duration');
  reason(() => requireRentalWindow({ ...rental, endsAt: at(61) }), 'duration_increment');
  reason(() => requireRentalWindow({ startsAt: at(1), endsAt: at(61), now: at(0) }), 'slot_alignment');
  reason(() => requireRentalWindow({ ...rental, endsAt: at(1470) }), 'maximum_duration');
  assert.equal(requireRentalWindow({ ...rental, now: at(-60 * 1440) }), 60);
  reason(() => requireRentalWindow({ ...rental, now: Date.parse(at(-60 * 1440)) - 1 }), 'outside_horizon');
  reason(() => requireRentalWindow({ ...rental, startsAt: 'bad' }), 'invalid_time');
  reason(() => requireRentalWindow({ startsAt: '2099-12-31T23:30:00+08:00', endsAt: '2100-01-01T00:30:00+08:00', now: '2099-12-31T23:00:00+08:00' }), 'invalid_time');
});

test('exact pricing clips bands, covers overnight and rounds once independently of rate splitting', () => {
  const price = priceRental(at(690), at(780), [band(0, 720, 10001), band(720, 1440, 20001)]);
  assert.equal(price.total_centavos, 25002); // 5000.5 + 20001 -> half up.
  assert.deepEqual(price.bands.map(b => b.duration_minutes), [30, 60]);
  assert.equal(priceRental(at(1410), at(1500), [band(1320, 1440, 1), band(1440, 1560, 1)]).total_centavos, 2);
  assert.equal(priceRental(at(0), at(60), [band(0, 30, 1), band(30, 60, 1)]).total_centavos, 1);
  assert.equal(priceRental(at(0), at(60), [band(0, 60, 1)]).total_centavos, 1);
  assert.equal(priceRental(at(0), at(60), [band(0, 60, 0)]).total_centavos, 0);
});

test('pricing rejects incomplete, overlapping, unsorted or invalid coverage and checks exact safe-integer totals', () => {
  for (const intervals of [[], [band(30, 60, 1)], [band(0, 30, 1)], [band(0, 30, 1), band(60, 90, 1)]]) {
    reason(() => priceRental(at(0), at(60), intervals), 'outside_hours');
  }
  for (const intervals of [[band(0, 60, 1), band(30, 90, 1)], [band(30, 60, 1), band(0, 30, 1)],
    [band(0, 60, -1)], [band(0, 60, 1.5)], [band(0, 60, Number.MAX_SAFE_INTEGER + 1)]]) {
    assert.throws(() => priceRental(at(0), at(60), intervals));
  }
  assert.equal(priceRental(at(0), at(60), [band(0, 60, Number.MAX_SAFE_INTEGER)]).total_centavos, Number.MAX_SAFE_INTEGER);
  assert.equal(priceRental(at(0), at(90), [band(0, 30, Number.MAX_SAFE_INTEGER), band(30, 90, 0)]).total_centavos, 4503599627370496);
  reason(() => priceRental(at(0), at(90), [band(0, 90, Number.MAX_SAFE_INTEGER)]), 'price_overflow');
  const intervals = [band(0, 60, 10001)];
  const original = priceRental(at(0), at(60), intervals);
  intervals[0].hourly_centavos = 90000;
  assert.equal(original.total_centavos, 10001); assert.equal(original.bands[0].hourly_centavos, 10001);
});
