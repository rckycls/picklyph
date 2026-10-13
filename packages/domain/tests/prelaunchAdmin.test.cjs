const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MAX_REGISTRATION_BATCH, codeDelivered, readRegistrationEmailFilter, readRegistrationErase, readRegistrationSend, readRegistrationStatus } = require('../src/prelaunchAdmin.ts');
const { CLAIM_CODE_ALPHABET, generateClaimCode, normalizeClaimCode } = require('../src/claimCode.ts');
const { newCodeEmail } = require('../src/prelaunchEmail.ts');
const { PrelaunchInputError } = require('../src/prelaunch.ts');

const id = (n) => `a5b00000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('console registration batches (T54b): exact bodies, 1–25 unique registrations, versions the database accepts', () => {
  assert.deepEqual(readRegistrationSend({ items: [{ id: id(1).toUpperCase(), code_version: 2 }, { code_version: 1, id: id(2) }] }),
    [{ id: id(1), code_version: 2 }, { id: id(2), code_version: 1 }]);
  assert.deepEqual(readRegistrationErase({ ids: [id(1), id(2)] }), [id(1), id(2)]);
  const refused = [
    [readRegistrationSend, null], [readRegistrationSend, []], [readRegistrationSend, { items: [] }], [readRegistrationSend, { items: [{ id: id(1), code_version: 1 }], extra: true }],
    [readRegistrationSend, { items: [{ id: id(1) }] }], [readRegistrationSend, { items: [{ id: id(1), code_version: 0 }] }],
    [readRegistrationSend, { items: [{ id: id(1), code_version: 1001 }] }], [readRegistrationSend, { items: [{ id: id(1), code_version: 1.5 }] }],
    [readRegistrationSend, { items: [{ id: id(1), code_version: '1' }] }], [readRegistrationSend, { items: [{ id: 'nope', code_version: 1 }] }],
    [readRegistrationSend, { items: [{ id: id(1), code_version: 1, extra: 1 }] }],
    [readRegistrationSend, { items: [{ id: id(1), code_version: 1 }, { id: id(1).toUpperCase(), code_version: 1 }] }],
    [readRegistrationSend, { items: Array.from({ length: MAX_REGISTRATION_BATCH + 1 }, (_, n) => ({ id: id(n), code_version: 1 })) }],
    [readRegistrationErase, { ids: [] }], [readRegistrationErase, { ids: [id(1), id(1)] }], [readRegistrationErase, { items: [id(1)] }],
    [readRegistrationErase, { ids: [42] }], [readRegistrationErase, { ids: Array.from({ length: MAX_REGISTRATION_BATCH + 1 }, (_, n) => id(n)) }],
  ];
  for (const [reader, body] of refused) assert.throws(() => reader(body), PrelaunchInputError, JSON.stringify(body));
  assert.equal(MAX_REGISTRATION_BATCH, 25);
});

test('console registration list: status tabs, the exact-address search and delivery state', () => {
  assert.deepEqual(['open', 'claimed', 'erased', 'all', '', undefined, 'pending'].map(readRegistrationStatus), ['open', 'claimed', 'erased', null, null, null, null]);
  assert.equal(readRegistrationEmailFilter('  Ana@Example.PH '), 'ana@example.ph');
  for (const blank of [undefined, null, '', '   ']) assert.equal(readRegistrationEmailFilter(blank), null);
  for (const bad of ['ana', 'ana@', 'a b@c.ph', ['ana@example.ph'], `${'a'.repeat(250)}@x.ph`]) assert.throws(() => readRegistrationEmailFilter(bad), /full email address/);
  assert.equal(codeDelivered({ code_version: 2, email_sent_version: 2 }), true);
  assert.equal(codeDelivered({ code_version: 2, email_sent_version: 1 }), false, 'a newer code that never went out');
  assert.equal(codeDelivered({ code_version: 1, email_sent_version: null }), false);
});

test('the shared code generator (moved from the registration page) and the new-code email', () => {
  const codes = Array.from({ length: 50 }, () => generateClaimCode());
  assert.ok(codes.every((code) => code.length === 10 && normalizeClaimCode(code) === code && [...code].every((symbol) => CLAIM_CODE_ALPHABET.includes(symbol))));
  assert.equal(new Set(codes).size, 50, 'random codes');
  // Rejection sampling: bytes at or above 240 (8 × 30) are skipped, so every symbol stays equally likely.
  const scripted = [new Uint8Array(16).fill(255), Uint8Array.from({ length: 16 }, (_, n) => n)];
  assert.equal(generateClaimCode(() => scripted.shift()), CLAIM_CODE_ALPHABET.slice(0, 10));
  const base = { ownerName: 'Ana <Cruz>', venueName: 'Hall & Courts', code: 'ABCDEFGHJK', contactEmail: 'hello@pickly.example', origin: 'https://register.pickly.example' };
  const later = newCodeEmail({ ...base, appUrl: null });
  assert.equal(later.subject, 'Your new pickly claim code for Hall & Courts');
  assert.match(later.text, /Your claim code: ABCDE-FGHJK/);
  assert.match(later.text, /Your earlier code no longer works/);
  assert.match(later.text, /When pickly launches, get the pickly app/);
  assert.match(later.text, /Claim with a code/);
  assert.match(later.text, /180 days after this email/);
  assert.match(later.text, /https:\/\/register\.pickly\.example\/privacy/);
  assert.ok(later.html.includes('Ana &lt;Cruz&gt;') && later.html.includes('Hall &amp; Courts') && !later.html.includes('<Cruz>'), 'escaped');
  const launched = newCodeEmail({ ...base, appUrl: 'https://apps.apple.com/app/id123?x="y"' });
  assert.match(launched.text, /Get the pickly app on your iPhone: https:\/\/apps\.apple\.com\/app\/id123/);
  assert.ok(launched.html.includes('href="https://apps.apple.com/app/id123?x=&quot;y&quot;"'), 'the link is escaped');
  assert.ok(!launched.text.includes('When pickly launches'));
});
