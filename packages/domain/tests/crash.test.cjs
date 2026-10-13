const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { CRASH_KINDS, CRASH_VARIANTS, CRASH_OS, CRASH_LIMITS, CRASH_DAILY_CAP, CRASH_RETENTION_DAYS, CRASH_VIEW_DAYS, MAX_CRASH_GROUPS,
  scrubCrashText, normalizeCrashRoute, readCrashReport, crashFingerprint, readCrashAdminView, CrashInputError } = require('../src/crash.ts');

const root = path.resolve(path.dirname(require.resolve('../src/crash.ts')), '../../..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261014090000_crash_reports.sql'), 'utf8');

test('the contract matches the migration: kinds, variants, systems, limits, cap, retention and the console window', () => {
  const quoted = (list) => list.map((value) => `'${value}'`).join(',');
  assert.ok(migration.includes(`kind in (${quoted(CRASH_KINDS)})`));
  assert.ok(migration.includes(`variant in (${quoted(CRASH_VARIANTS)})`));
  assert.ok(migration.includes(`os in (${quoted(CRASH_OS)})`));
  assert.ok(migration.includes(`char_length(name) <= ${CRASH_LIMITS.name}`));
  for (const field of ['message', 'stack', 'component_stack', 'route']) assert.ok(migration.includes(`char_length(${field}) <= ${CRASH_LIMITS[field]}`), field);
  assert.match(migration, new RegExp(`interval '24 hours'\\) >= ${CRASH_DAILY_CAP} then`));
  assert.match(migration, new RegExp(`x\\.received_at < clock_timestamp\\(\\) - interval '${CRASH_RETENTION_DAYS} days'`));
  assert.match(migration, new RegExp(`'days', ${CRASH_VIEW_DAYS},`));
  const read = migration.slice(migration.indexOf('create function public.crash_admin_read'));
  assert.deepEqual([...new Set([...read.matchAll(/interval '(\d+) days'/g)].map((m) => Number(m[1])))], [CRASH_VIEW_DAYS]);
  assert.match(migration, new RegExp(`limit ${MAX_CRASH_GROUPS}\\) g`));
  const keys = /keys text\[\] := array\[([^\]]*)\]/.exec(migration)[1].match(/'([a-z_]+)'/g).map((key) => key.slice(1, -1)).sort();
  assert.deepEqual(keys, Object.keys(report()).concat('fingerprint').sort(), 'the database takes the report plus the fingerprint');
});

test('scrubbing removes personal data, tokens, keys, addresses and query strings, keeps stack positions and is stable', () => {
  const cases = [
    ['Booking for ana.reyes+test@example.com.ph failed', 'Booking for <email> failed'],
    ['Call 09171234567 or +63 917 123 4567 or 0917-123-4567', 'Call <number> or <number> or <number>'],
    ['venue c4370000-0000-4000-8000-00000000000A missing', 'venue <id> missing'],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_def-1 rejected', 'token <token> rejected'],
    ['Authorization: Bearer abc.def.ghi', 'Authorization: Bearer <token>'],
    // A fake key, assembled so secret scanners don't flag the fixture.
    [`key ${'sb_' + 'secret_'}abcDEF123_xyz and sb_publishable_Q-1`, 'key <key> and <key>'],
    ['push ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] gone', 'push <token> gone'],
    ['at fn (http://192.168.1.20:8081/index.bundle?platform=ios&dev=true&token=abc:1:2345)', 'at fn (http://<ip>:8081/index.bundle)'],
    ['GET https://x.supabase.co/rest/v1/venues?select=*&apikey=sb_publishable_1#frag failed', 'GET https://x.supabase.co/rest/v1/venues failed'],
    ['host fe80:0:0:0:1ff:fe23:4567:890a down', 'host <ip> down'],
    ['line\r\nbreak\u0000‮hidden', 'line\nbreakhidden'],
    ['    at anonymous (address at index.bundle:1:5512345)', '    at anonymous (address at index.bundle:1:5512345)'],
    ['spot 12 of 16 at 10:30', 'spot 12 of 16 at 10:30'],
  ];
  for (const [input, output] of cases) {
    assert.equal(scrubCrashText(input, 500), output, input);
    assert.equal(scrubCrashText(output, 500), output, `stable: ${output}`);
  }
  assert.equal(scrubCrashText('a'.repeat(20), 10), `${'a'.repeat(9)}…`);
  assert.equal([...scrubCrashText('🎾'.repeat(20), 10)].length, 10, 'cut by code points');
  assert.equal(scrubCrashText('a@b.co'.repeat(3), 10).length <= 10, true, 'replacements that grow are still cut');
});

test('routes keep the screen and lose IDs, numbers, long values, queries and hashes', () => {
  assert.equal(normalizeCrashRoute('/rental/venue/c4370000-0000-4000-8000-000000000001'), '/rental/venue/[id]');
  assert.equal(normalizeCrashRoute('/owner/desk/42?date=2026-10-14#top'), '/owner/desk/[id]');
  assert.equal(normalizeCrashRoute('/play/session/abcDEF0123456789xyzQ'), '/play/session/[id]');
  assert.equal(normalizeCrashRoute('/'), '/');
  assert.equal(normalizeCrashRoute(''), '/');
  assert.equal(normalizeCrashRoute('/(tabs)/account'), '/(tabs)/account');
  assert.ok(normalizeCrashRoute(`/${'a/'.repeat(150)}`).length <= CRASH_LIMITS.route);
});

function report(patch = {}) {
  return { id: 'C51D0000-0000-4000-8000-000000000001', kind: 'fatal', name: 'TypeError', message: 'Cannot read property of ana@example.com',
    stack: 'TypeError: boom\n    at anonymous (address at index.bundle:1:2345)', component_stack: null, route: '/rental/venue/[id]',
    app_version: '0.1.0', variant: 'preview', os: 'ios', os_version: '18.6', occurred_at: '2026-10-14T09:02:03.456789+08:00', ...patch };
}

test('reports parse strictly and come out scrubbed, with a lowercase ID and an ISO time', () => {
  assert.deepEqual(readCrashReport(report()), { ...report(), id: 'c51d0000-0000-4000-8000-000000000001', message: 'Cannot read property of <email>',
    occurred_at: '2026-10-14T01:02:03.456Z' });
  assert.equal(readCrashReport(report({ kind: 'render', component_stack: 'in VenueSheet\nin Screen', stack: null, route: null })).component_stack, 'in VenueSheet\nin Screen');
  assert.equal(readCrashReport(report({ message: '' })).message, '', 'an empty message is allowed');
  const limits = readCrashReport(report({ name: 'n'.repeat(100), message: 'm'.repeat(500), stack: 's'.repeat(6000), route: `/${'r'.repeat(199)}` }));
  assert.equal(limits.stack.length, 6000);
  const { id, ...withoutId } = report();
  for (const bad of [null, [], 'report', withoutId, report({ extra: 1 }), report({ id: 'nope' }), report({ kind: 'warning' }), report({ variant: 'staging' }),
    report({ os: 'web' }), report({ name: '' }), report({ name: ' \t' }), report({ name: '\u0000' }), report({ name: 'n'.repeat(101) }), report({ message: 'm'.repeat(501) }),
    report({ message: null }), report({ stack: 's'.repeat(6001) }), report({ stack: 7 }), report({ component_stack: 'in X' }),
    report({ kind: 'render', component_stack: 'c'.repeat(3001) }), report({ route: 'rental' }), report({ route: '/v?id=1' }), report({ route: '/a b' }),
    report({ app_version: '' }), report({ app_version: '1.0 beta' }), report({ os_version: '18;6' }), report({ occurred_at: 'yesterday' }),
    report({ occurred_at: '2026-13-40T00:00:00Z' }), report({ occurred_at: 1760400000000 })]) {
    assert.throws(() => readCrashReport(bad), CrashInputError, JSON.stringify(bad)?.slice(0, 120));
  }
});

test('fingerprints group repeats of one crash and separate different ones', async () => {
  const base = { kind: 'fatal', name: 'TypeError', message: 'Spot 3 of 12 failed', stack: 'TypeError: x\n    at a (index.bundle:1:100)\n    at b (index.bundle:1:200)', component_stack: null };
  const fp = await crashFingerprint(base);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(await crashFingerprint({ ...base, message: 'Spot 7 of 16 failed' }), fp, 'numbers in the message do not split a group');
  assert.equal(await crashFingerprint({ ...base, stack: `TypeError: other text\n${base.stack.split('\n').slice(1).join('\n')}` }), fp, 'only frames count from the stack');
  const sixth = `${base.stack}\n    at c (index.bundle:1:300)\n    at d (index.bundle:1:400)\n    at e (index.bundle:1:500)`;
  assert.equal(await crashFingerprint({ ...base, stack: `${sixth}\n    at f (index.bundle:1:600)` }), await crashFingerprint({ ...base, stack: `${sixth}\n    at g (index.bundle:1:700)` }),
    'the first five frames');
  assert.notEqual(await crashFingerprint({ ...base, stack: base.stack.replace('1:100', '1:101') }), fp, 'a different site in a minified bundle');
  assert.notEqual(await crashFingerprint({ ...base, kind: 'error' }), fp);
  assert.notEqual(await crashFingerprint({ ...base, name: 'RangeError' }), fp);
  assert.notEqual(await crashFingerprint({ ...base, message: 'Spot failed' }), fp);
  const render = { ...base, kind: 'render', component_stack: 'in A\nin B\nin C\nin D' };
  assert.notEqual(await crashFingerprint({ ...render, component_stack: 'in X\nin B\nin C' }), await crashFingerprint(render), 'render errors use their components');
  assert.equal(await crashFingerprint({ ...render, component_stack: 'in A\nin B\nin C\nin Z' }), await crashFingerprint(render), 'the first three components');
});

const group = (patch = {}) => ({ fingerprint: 'a'.repeat(64), kind: 'fatal', name: 'TypeError', message: 'boom', reports: 3, development: 1, preview: 0, production: 2,
  first_seen: '2026-10-13T01:00:00.123456+00:00', last_seen: '2026-10-14T01:00:00+00:00', app_version: '0.1.0', os: 'ios', os_version: '18.6',
  route: null, stack: 'at a', component_stack: null, ...patch });

test('the console view parses strictly', () => {
  const view = readCrashAdminView({ at: '2026-10-14T02:00:00.5+00:00', days: 7, total: 4, groups: [group()] });
  assert.deepEqual(view, { at: '2026-10-14T02:00:00.500Z', days: 7, total: 4, groups: [{ ...group(), first_seen: '2026-10-13T01:00:00.123Z', last_seen: '2026-10-14T01:00:00.000Z' }] });
  assert.deepEqual(readCrashAdminView({ at: '2026-10-14T02:00:00Z', days: 7, total: 0, groups: [] }).groups, []);
  for (const bad of [null, { at: 'x', days: 7, total: 0, groups: [] }, { at: '2026-10-14T02:00:00Z', days: 8, total: 0, groups: [] },
    { at: '2026-10-14T02:00:00Z', days: 7, total: -1, groups: [] }, { at: '2026-10-14T02:00:00Z', days: 7, total: 0, groups: Array(51).fill(group()) },
    ...[{ fingerprint: 'abc' }, { kind: 'warning' }, { reports: 0, development: 0, production: 0 }, { preview: 1 }, { os: 'web' },
      { message: 'm'.repeat(501) }, { stack: 7 }, { last_seen: null }, { route: 5 }].map((patch) => ({ at: '2026-10-14T02:00:00Z', days: 7, total: 3, groups: [group(patch)] }))]) {
    assert.throws(() => readCrashAdminView(bad), /Unexpected crash view/, JSON.stringify(bad)?.slice(0, 160));
  }
});
