const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EMAIL_SPACING_MS, RegistrationSettingsError, eraseRegistrations, readRegistrationSettings, registrationFailureMessage, sendNewCodes } = require('../src/lib/registrations.ts');
const { hashClaimCode } = require('@picklyph/domain/src/claimCode.ts');
const { EmailUnavailable } = require('@picklyph/domain/src/prelaunchEmail.ts');

const secret = 'console-code-secret-console-code-secret';
const env = {
  PRELAUNCH_CODE_SECRET: secret, PRELAUNCH_ORIGIN: 'https://register.pickly.example', PRELAUNCH_CONTACT_EMAIL: 'Hello@Pickly.Example',
  EMAIL_API_KEY: 're_console', EMAIL_FROM: 'pickly <hello@pickly.example>',
};
const settings = readRegistrationSettings(env);
const id = (n) => `a5b00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rotated = (n, version = 2) => ({ outcome: 'rotated', registration_id: id(n), code_version: version, owner_name: 'Ana Cruz', email: `owner${n}@example.ph`, venue_name: `Courts ${n}` });

test('console code settings (T54b): every value server-side, https or this machine only, no placeholders', () => {
  assert.deepEqual(settings, { codeSecret: secret, origin: 'https://register.pickly.example', contactEmail: 'hello@pickly.example', appUrl: null,
    email: { apiUrl: 'https://api.resend.com/emails', apiKey: 're_console', from: 'pickly <hello@pickly.example>', replyTo: 'hello@pickly.example' } });
  assert.equal(readRegistrationSettings({ ...env, PRELAUNCH_APP_URL: 'https://apps.apple.com/ph/app/pickly/id123' }).appUrl, 'https://apps.apple.com/ph/app/pickly/id123');
  assert.equal(readRegistrationSettings({ ...env, EMAIL_API_URL: 'http://127.0.0.1:4010/emails', PRELAUNCH_ORIGIN: 'http://localhost:3200' }).email.apiUrl, 'http://127.0.0.1:4010/emails');
  for (const change of [{ PRELAUNCH_CODE_SECRET: undefined }, { PRELAUNCH_CODE_SECRET: 'short' }, { PRELAUNCH_CODE_SECRET: 'REPLACE_WITH_SAME_SECRET_AS_THE_REGISTRATION_PAGE' },
    { PRELAUNCH_ORIGIN: 'http://register.pickly.example' }, { PRELAUNCH_ORIGIN: 'https://register.pickly.example/register' },
    { PRELAUNCH_CONTACT_EMAIL: 'nobody' }, { EMAIL_API_KEY: '' }, { EMAIL_API_KEY: 're_ with space' }, { EMAIL_FROM: 'pickly' },
    { EMAIL_FROM: 'pickly <hello@pickly.example>\r\nBcc: x@y.z' }, { EMAIL_API_URL: 'http://mail.example/emails' },
    { EMAIL_API_URL: 'https://user:pass@mail.example/emails' }, { PRELAUNCH_APP_URL: 'http://localhost/app' }, { PRELAUNCH_APP_URL: 'not a url' }]) {
    assert.throws(() => readRegistrationSettings({ ...env, ...change }), RegistrationSettingsError, JSON.stringify(change));
  }
});

test('send new codes: rotate at the seen version, email the code whose hash was stored, record that version, one at a time', async () => {
  const calls = [];
  const codes = ['ABCDEFGHJK', 'BCDEFGHJKM', 'CDEFGHJKMN'];
  const outcomes = await sendNewCodes([{ id: id(1), code_version: 1 }, { id: id(2), code_version: 4 }], { ...settings, appUrl: 'https://apps.apple.com/app/id1' }, {
    generateCode: () => codes.shift(),
    rotate: async (registration, version, hash) => { calls.push(['rotate', registration, version, hash]); return { data: rotated(registration === id(1) ? 1 : 2, version + 1), error: null }; },
    sendEmail: async (email) => { calls.push(['email', email]); },
    emailSent: async (registration, version) => { calls.push(['sent', registration, version]); return { data: true, error: null }; },
    pause: async (ms) => { calls.push(['pause', ms]); },
  });
  assert.deepEqual(outcomes, [{ id: id(1), done: true, message: null }, { id: id(2), done: true, message: null }]);
  assert.deepEqual(calls.map((call) => call[0]), ['rotate', 'email', 'sent', 'rotate', 'pause', 'email', 'sent'], 'spaced, in order, nothing before its rotation');
  assert.deepEqual(calls[0].slice(1, 3), [id(1), 1]);
  assert.equal(calls[0][3], await hashClaimCode(secret, 'ABCDEFGHJK'), 'the stored hash is the emailed code\'s');
  assert.equal(calls[4][1], EMAIL_SPACING_MS);
  const first = calls[1][1];
  assert.equal(first.to, 'owner1@example.ph');
  assert.equal(first.idempotencyKey, `prelaunch-${id(1)}-v2`, 'one email per code version, without the code');
  assert.match(first.text, /ABCDE-FGHJK/);
  assert.match(first.text, /https:\/\/apps\.apple\.com\/app\/id1/);
  assert.ok(!first.idempotencyKey.includes('ABCDE'));
  assert.deepEqual(calls[2].slice(1), [id(1), 2]);
  assert.deepEqual(calls[6].slice(1), [id(2), 5]);
});

test('send new codes: collisions retry with another code; refusals, failed emails and lost delivery records are reported per registration', async () => {
  let collisions = 0;
  const rotations = [];
  const outcomes = await sendNewCodes([
    { id: id(1), code_version: 1 }, { id: id(2), code_version: 1 }, { id: id(3), code_version: 1 }, { id: id(4), code_version: 1 }, { id: id(5), code_version: 1 },
  ], settings, {
    rotate: async (registration, version, hash) => {
      rotations.push([registration, hash]);
      if (registration === id(1) && collisions++ < 2) return { data: null, error: { code: '23505', hint: 'code_collision' } };
      if (registration === id(2)) return { data: null, error: { code: '40001', hint: 'changed' } };
      if (registration === id(3)) throw new Error('network');
      return { data: rotated(Number(registration.slice(-1))), error: null };
    },
    sendEmail: async (email) => { if (email.to === 'owner4@example.ph') throw new EmailUnavailable(); },
    emailSent: async (registration) => registration === id(5) ? { data: null, error: { code: '08006' } } : { data: true, error: null },
    pause: async () => {},
  });
  assert.equal(rotations.filter(([registration]) => registration === id(1)).length, 3);
  assert.equal(new Set(rotations.filter(([registration]) => registration === id(1)).map(([, hash]) => hash)).size, 3, 'a new code each try');
  assert.deepEqual(outcomes, [
    { id: id(1), done: true, message: null },
    { id: id(2), done: false, message: 'It changed after you loaded the list (another code may have gone out). Reload and check before sending again.' },
    { id: id(3), done: false, message: 'Unavailable right now. Try again.' },
    { id: id(4), done: false, message: 'The new code was made but the email didn’t go out, so the earlier code no longer works. Send again.' },
    { id: id(5), done: true, message: 'Sent, but the delivery wasn’t recorded. Reload to check it.' },
  ]);
  const always = await sendNewCodes([{ id: id(6), code_version: 1 }], settings, {
    rotate: async () => ({ data: null, error: { code: '23505', hint: 'code_collision' } }), sendEmail: async () => assert.fail('no email'),
    emailSent: async () => assert.fail('no record'), pause: async () => {},
  });
  assert.deepEqual(always, [{ id: id(6), done: false, message: 'Unavailable right now. Try again.' }], 'gives up after three collisions');
});

test('refusal messages and erase outcomes', async () => {
  const messages = [['not_open', /claimed or erased/], ['listing_unavailable', /suspended/], ['already_verified', /verified owner/], ['not_found', /no longer exists/],
    ['invalid_input', /Reload the list/]];
  for (const [hint, words] of messages) assert.match(registrationFailureMessage({ hint }), words, hint);
  assert.equal(registrationFailureMessage({ code: '42501' }), 'Administrator access required.');
  assert.match(registrationFailureMessage({ code: 'PGRST202' }), /latest database update/);
  assert.equal(registrationFailureMessage({ code: 'XX000' }), 'Unavailable right now. Try again.');
  const outcomes = await eraseRegistrations([id(1), id(2), id(3), id(4)], async (registration) => {
    if (registration === id(1)) return { data: { outcome: 'erased', registration_id: registration, listing_suspended: true }, error: null };
    if (registration === id(2)) return { data: { outcome: 'existing', registration_id: registration, listing_suspended: false }, error: null };
    if (registration === id(3)) return { data: null, error: { code: '42501' } };
    throw new Error('network');
  });
  assert.deepEqual(outcomes, [{ id: id(1), done: true, message: null }, { id: id(2), done: true, message: 'Already erased.' },
    { id: id(3), done: false, message: 'Administrator access required.' }, { id: id(4), done: false, message: 'Unavailable right now. Try again.' }]);
});
