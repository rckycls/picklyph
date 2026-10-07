const assert = require('node:assert/strict');
const { test } = require('node:test');
const { displayNameInput, initials, memberSince, profileName, signInMethod } = require('../profile.ts');

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

test('member-since and sign-in labels tolerate unknown input', () => {
  assert.equal(memberSince('2026-10-15T12:00:00Z'), 'Oct 2026');
  assert.equal(memberSince('not a date'), null);
  assert.equal(memberSince(undefined), null);
  assert.equal(signInMethod('apple'), 'Apple');
  assert.equal(signInMethod('email'), 'Email code');
  assert.equal(signInMethod('google'), null);
});

test('display names follow the database check', () => {
  assert.deepEqual(displayNameInput('  Rocky  '), { ok: true, value: 'Rocky' });
  assert.deepEqual(displayNameInput('   '), { ok: true, value: null });
  assert.equal(displayNameInput('a'.repeat(80)).ok, true);
  assert.equal(displayNameInput('a'.repeat(81)).ok, false);
  // Code points, not UTF-16 units, like char_length.
  assert.equal(displayNameInput('🏓'.repeat(80)).ok, true);
});
