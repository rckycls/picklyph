const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  avatarProblem, displayNameInput, formatPhone, fullName, initials, maskEmail, maskPhone, memberSince, personNameInput, phoneInput, profileName,
} = require('../profile.ts');

test('saved names win; otherwise the email becomes a readable name', () => {
  assert.equal(profileName('  Rocky Celis ', 'rocky@example.com'), 'Rocky Celis');
  assert.equal(profileName(null, 'maria.santos@example.com'), 'Maria Santos');
  assert.equal(profileName(null, 'player_23@example.com'), 'Player');
  assert.equal(profileName('   ', 'jo-ann+courts@example.com'), 'Jo Ann Courts');
});

test('relay, numeric or missing emails fall back to a neutral name', () => {
  assert.equal(profileName(null, 'x7k2m9@privaterelay.appleid.com'), 'Pickly player');
  assert.equal(profileName(null, '0917555@example.com'), 'Pickly player');
  assert.equal(profileName(null, null), 'Pickly player');
});

test('initials use the first and last word', () => {
  assert.equal(initials('Rocky Celis'), 'RC');
  assert.equal(initials('Maria de la Cruz'), 'MC');
  assert.equal(initials('ñino'), 'Ñ');
  assert.equal(initials(''), '');
});

test('member-since tolerates unknown input', () => {
  assert.equal(memberSince('2026-10-15T12:00:00Z'), 'Oct 2026');
  assert.equal(memberSince('not a date'), null);
  assert.equal(memberSince(undefined), null);
});

test('a display name wins, then first and last name, then the email', () => {
  assert.equal(profileName('Rocks', 'rocky@example.com', 'Rocky', 'Celis'), 'Rocks');
  assert.equal(profileName(null, 'rocky@example.com', 'Rocky', 'Celis'), 'Rocky Celis');
  assert.equal(profileName(null, 'rocky@example.com', null, ' Celis '), 'Celis');
  assert.equal(fullName('  ', null), null);
});

test('first and last names follow the database check', () => {
  assert.deepEqual(personNameInput('  Maria   Clara '), { ok: true, value: 'Maria Clara' });
  assert.deepEqual(personNameInput(''), { ok: true, value: null });
  assert.equal(personNameInput('a'.repeat(50)).ok, true);
  assert.equal(personNameInput('a'.repeat(51)).ok, false);
  assert.equal(personNameInput('Ma\u0007ria').ok, false);
});

test('Philippine mobile numbers normalize to +639XXXXXXXXX', () => {
  for (const typed of ['0917 123 4567', '+63 917-123-4567', '9171234567', '639171234567', '(0917) 123 4567']) {
    assert.deepEqual(phoneInput(typed), { ok: true, value: '+639171234567' }, typed);
  }
  assert.deepEqual(phoneInput('  '), { ok: true, value: null });
  for (const bad of ['0817 123 4567', '0917 123 456', '+1 415 555 0100', '02 8123 4567', 'call me']) assert.equal(phoneInput(bad).ok, false, bad);
  assert.equal(formatPhone('+639171234567'), '+63 917 123 4567');
  assert.equal(maskPhone('+639171234567'), '+63 *** *** **67');
});

test('emails are masked to the first character and the domain', () => {
  assert.equal(maskEmail('rckycls000@gmail.com'), 'r******@gmail.com');
  assert.equal(maskEmail('a@b.co'), 'a******@b.co');
  assert.equal(maskEmail('not-an-email'), '******');
});

test('profile photos are JPEG or PNG up to 5 MB', () => {
  assert.deepEqual(avatarProblem({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', fileSize: 1000 }), { type: 'image/jpeg' });
  assert.deepEqual(avatarProblem({ uri: 'file:///a.PNG' }), { type: 'image/png' });
  assert.ok('problem' in avatarProblem({ uri: 'file:///a.heic', mimeType: 'image/heic' }));
  assert.ok('problem' in avatarProblem({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', fileSize: 5 * 1024 * 1024 + 1 }));
});

test('display names follow the database check', () => {
  assert.deepEqual(displayNameInput('  Rocky  '), { ok: true, value: 'Rocky' });
  assert.deepEqual(displayNameInput('   '), { ok: true, value: null });
  assert.equal(displayNameInput('a'.repeat(80)).ok, true);
  assert.equal(displayNameInput('a'.repeat(81)).ok, false);
  // Code points, not UTF-16 units, like char_length.
  assert.equal(displayNameInput('🏓'.repeat(80)).ok, true);
});
