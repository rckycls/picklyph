const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  CLAIM_CODE_ALPHABET, CLAIM_CODE_LENGTH, formatClaimCode, normalizeClaimCode, readAddressQuery, readMobileNumber,
  readPrelaunchRegistration, readPrelaunchRequest,
} = require('../src/prelaunch.ts');

const venue = { name: ' Rizal  Courts ', address_line: '12 Mabini St', city: 'Makati', province: 'Metro Manila', latitude: 14.55, longitude: 121.02, court_count: 4 };
const registration = (patch = {}) => ({
  owner_name: ' Ana  Cruz ', email: ' Ana@Example.PH ', phone: '0917 123 4567', role: 'manager', venue,
  courts: { indoor: true, covered: true, surface: 'synthetic' }, note: '  Gate on Mabini St.\r\nAsk for Ana. ', consent: true, ...patch,
});
const request = (patch = {}) => ({
  request_key: 'A1B2C3D4-0000-4000-8000-000000000001', turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX', acknowledge_duplicates: false,
  registration: registration(), ...patch,
});

test('registration bodies normalize text, email and mobile numbers and keep the exact field set', () => {
  const read = readPrelaunchRequest(request());
  assert.equal(read.request_key, 'a1b2c3d4-0000-4000-8000-000000000001');
  assert.deepEqual(read.registration, {
    owner_name: 'Ana Cruz', email: 'ana@example.ph', phone: '+639171234567', role: 'manager',
    venue: { ...venue, name: 'Rizal Courts' }, courts: { indoor: true, covered: true, surface: 'synthetic' },
    note: 'Gate on Mabini St.\nAsk for Ana.', consent: true,
  });
  assert.equal(readPrelaunchRegistration(registration({ phone: '', note: '  ' })).phone, null);
  assert.equal(readPrelaunchRegistration(registration({ phone: null, note: null })).note, null);
  for (const phone of ['+63 917 123 4567', '639171234567', '9171234567', '(0917) 123-4567']) assert.equal(readMobileNumber(phone), '+639171234567');
  for (const phone of ['0817 123 4567', '0917 123 456', '+1 917 123 4567', 917]) assert.throws(() => readMobileNumber(phone), { name: 'PrelaunchInputError' });
});

test('registration bodies refuse missing consent, bad fields, extra keys and out-of-range venues', () => {
  const bad = [
    registration({ consent: false }), registration({ consent: 'yes' }), registration({ owner_name: '' }), registration({ owner_name: 'x'.repeat(121) }),
    registration({ owner_name: 'Ana\u0007' }), registration({ email: 'ana@' }), registration({ email: 'a b@example.ph' }),
    registration({ role: 'admin' }), registration({ courts: { indoor: true, covered: true } }),
    registration({ courts: { indoor: 'yes', covered: true, surface: null } }), registration({ courts: { indoor: true, covered: true, surface: 'clay' } }),
    registration({ venue: { ...venue, latitude: 35.6 } }), registration({ venue: { ...venue, court_count: 41 } }),
    registration({ venue: { ...venue, court_count: 0 } }), registration({ note: 'x'.repeat(501) }), registration({ extra: true }),
    { ...registration(), consent: undefined },
  ];
  for (const body of bad) assert.throws(() => readPrelaunchRegistration(body), { name: 'PrelaunchInputError' });
  assert.throws(() => readPrelaunchRegistration(registration({ venue: { ...venue, latitude: 35.6 } })), /Place the pin on the venue in the Philippines/);
  assert.throws(() => readPrelaunchRegistration(registration({ consent: false })), /privacy notice/);
  for (const body of [
    request({ request_key: 'not-a-uuid' }), request({ turnstile_token: '' }), request({ turnstile_token: 'x'.repeat(2049) }),
    request({ acknowledge_duplicates: 'true' }), request({ actor_user_id: 'x' }), null, [], 'text',
  ]) assert.throws(() => readPrelaunchRequest(body), { name: 'PrelaunchInputError' });
});

test('address queries are bounded and claim codes format and normalize over the unambiguous alphabet', () => {
  assert.equal(readAddressQuery({ query: '  12  Mabini St, Makati ' }), '12 Mabini St, Makati');
  for (const body of [{ query: 'ab' }, { query: 'x'.repeat(201) }, { query: 'Mak\u0007ati' }, { query: 3 }, { query: 'Makati', extra: 1 }, null]) {
    assert.throws(() => readAddressQuery(body), { name: 'PrelaunchInputError' });
  }
  assert.equal(CLAIM_CODE_ALPHABET.length, 30);
  assert.equal(new Set(CLAIM_CODE_ALPHABET).size, 30);
  for (const ambiguous of '01ILOU') assert.ok(!CLAIM_CODE_ALPHABET.includes(ambiguous));
  assert.equal(formatClaimCode('ABCDEFGHJK'), 'ABCDE-FGHJK');
  assert.equal(normalizeClaimCode(' abcde-fghjk '), 'ABCDEFGHJK');
  assert.equal(normalizeClaimCode('ab cde fg hjk'), 'ABCDEFGHJK');
  for (const code of ['ABCDE-FGHJ', 'ABCDE-FGHJKL', 'ABCDE-FGHJ0', 'ABCDE-FGHJI', 12, null, 'A'.repeat(41)]) assert.equal(normalizeClaimCode(code), null);
  assert.equal(CLAIM_CODE_LENGTH, 10);
});
