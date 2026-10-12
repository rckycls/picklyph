const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { OPS_CHECKS, OPS_CHECK_NAMES, OPS_EXTERNAL_CHECKS, OPS_SIGNAL_SOURCES, OPS_SIGNAL_KINDS, OPS_MESSAGE_LIMIT, readOpsRun, opsAlertMessage,
  isOpsWebhookUrl, isOpsHeartbeatUrl, isOpsCheckName } = require('../src/ops.ts');

const root = path.resolve(path.dirname(require.resolve('../src/ops.ts')), '../../..');
const migrations = path.join(root, 'supabase/migrations');
const read = (file) => fs.readFileSync(path.join(migrations, file), 'utf8');
const migration = read('20261011120000_ops_monitoring.sql');
// The newest migration that (re)defines something holds its current definition (T51b replaced ops_health and the source list).
const latest = (pattern) => read(fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort().reverse().find((file) => pattern.test(read(file))));

test('the contract matches the migrations: every SQL check is named here, and the signal sources are the served functions', () => {
  const health = latest(/function private\.ops_health\(/);
  const sqlChecks = [...health.matchAll(/private\.ops_check\('([a-z_.]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(sqlChecks)].sort(), OPS_CHECK_NAMES.filter((name) => !OPS_EXTERNAL_CHECKS.includes(name)).sort());
  assert.deepEqual([...OPS_EXTERNAL_CHECKS].sort(), ['redis.isolation', 'redis.reachable']);
  assert.match(migration, /not in \('redis\.reachable','redis\.isolation'\)/);
  const signals = latest(/function public\.ops_signal_record\(/);
  assert.equal(signals, latest(/constraint ops_signals_source_check|source text not null check/), 'the table check and the command change together');
  const sources = [...signals.matchAll(/source (?:not )?in \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((s) => s[1]).sort());
  assert.equal(sources.length, 2, 'table check and command validation');
  for (const list of sources) assert.deepEqual(list, [...OPS_SIGNAL_SOURCES].sort());
  const served = fs.readdirSync(path.join(root, 'supabase/functions'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !['_shared', 'tests', 'ops-monitor'].includes(entry.name)).map((entry) => entry.name).sort();
  assert.deepEqual(served, [...OPS_SIGNAL_SOURCES].sort(), 'every served function except the monitor reports signals');
  assert.deepEqual([...migration.matchAll(/kind (?:not )?in \(([^)]*)\)/g)].map((m) => m[1].replace(/\s/g, '')), Array(2).fill(OPS_SIGNAL_KINDS.map((k) => `'${k}'`).join(',')));
  assert.deepEqual([...signals.matchAll(/kind (?:not )?in \(([^)]*)\)/g)].map((m) => m[1].replace(/\s/g, '')), [OPS_SIGNAL_KINDS.map((k) => `'${k}'`).join(',')]);
  for (const name of OPS_CHECK_NAMES) assert.ok(isOpsCheckName(name));
  assert.ok(!isOpsCheckName('toString') && !isOpsCheckName('constructor'), 'own names only');
});

const run = (patch = {}) => ({ at: '2026-10-11T10:37:30.06229+00:00', checks: [{ check: 'holds.overdue', status: 'fail', count: 2 }],
  alerts: [{ check: 'holds.overdue', status: 'fail', previous: 'ok', count: 2, since: '2026-10-11T10:30:00.5+00:00' }], ...patch });

test('monitor runs parse strictly, with database microseconds trimmed to milliseconds', () => {
  const parsed = readOpsRun(run());
  assert.equal(parsed.at, '2026-10-11T10:37:30.062Z');
  assert.equal(parsed.alerts[0].since, '2026-10-11T10:30:00.500Z');
  assert.equal(readOpsRun(run({ at: '2026-10-11T18:37:30+08:00' })).at, '2026-10-11T10:37:30.000Z');
  for (const bad of [null, [], run({ at: 'yesterday' }), run({ checks: {} }), run({ alerts: [{}] }), run({ checks: [{ check: 'holds.overdue', status: 'fail', count: -1 }] }),
    run({ checks: [{ check: 'holds.overdue', status: 'bad', count: 1 }] }), run({ checks: [{ check: 'secret.value', status: 'ok', count: 0 }] }),
    run({ checks: [{ check: 'holds.overdue', status: 'ok', count: 1.5 }] }), run({ checks: Array(51).fill({ check: 'holds.overdue', status: 'ok', count: 0 }) }),
    run({ alerts: [{ check: 'holds.overdue', status: 'fail', previous: 'maybe', count: 1, since: '2026-10-11T10:30:00Z' }] }),
    run({ alerts: [{ check: 'holds.overdue', status: 'fail', previous: 'ok', count: 1, since: '2026-13-45T10:30:00Z' }] })]) {
    assert.throws(() => readOpsRun(bad), /Unexpected monitor run/, JSON.stringify(bad));
  }
});

test('alert messages: environment, problems before recoveries, reminders with Manila time, escalations, counts only', () => {
  const message = opsAlertMessage('staging', [
    { check: 'holds.overdue', status: 'ok', previous: 'fail', count: 0, since: '2026-10-11T10:00:00.000Z' },
    { check: 'edge.errors', status: 'warn', previous: 'ok', count: 3, since: '2026-10-11T10:00:00.000Z' },
    { check: 'cron.failures', status: 'fail', previous: 'warn', count: 3, since: '2026-10-11T10:00:00.000Z' },
    { check: 'redis.reachable', status: 'fail', previous: 'fail', count: 1, since: '2026-10-11T10:05:00.000Z' },
  ]);
  assert.equal(message, [
    '**PicklyPH staging** monitor: 3 problems, 1 resolved',
    '🔴 FAIL (was WARN) · Scheduled job runs: 3 failed runs in the last 15 minutes',
    '🔴 STILL FAILING since Oct 11, 6:05 PM (Manila) · Redis: not reachable or not configured from the monitor',
    '🟡 WARN · Edge functions: 3 server errors in the last 15 minutes',
    '✅ RESOLVED · Hold sweep',
  ].join('\n'));
  assert.equal(opsAlertMessage('production', [{ check: 'cron.jobs', status: 'fail', previous: 'ok', count: 1, since: '2026-10-11T10:00:00.000Z' }]),
    '**PicklyPH production** monitor: 1 problem\n🔴 FAIL · Scheduled jobs: 1 expected pg_cron job is missing or inactive');
  assert.match(opsAlertMessage(undefined, [{ check: 'cron.jobs', status: 'ok', previous: 'fail', count: 0, since: '2026-10-11T10:00:00.000Z' }]),
    /^\*\*PicklyPH unknown environment\*\* monitor: 1 resolved\n✅ RESOLVED · Scheduled jobs$/);
  assert.match(opsAlertMessage('<@everyone>', []), /unknown environment/, 'the environment label is never free text');
  for (const name of OPS_CHECK_NAMES) {
    for (const count of [1, 2]) assert.doesNotMatch(OPS_CHECKS[name].problem(count), /undefined|NaN|\{|\}/);
  }
  const many = Array.from({ length: 50 }, () => ({ check: 'inventory.mismatch', status: 'fail', previous: 'ok', count: 999999, since: '2026-10-11T10:00:00.000Z' }));
  const capped = opsAlertMessage('staging', many);
  assert.ok(capped.length <= OPS_MESSAGE_LIMIT, `${capped.length} characters`);
  assert.match(capped, /…and more; see docs\/monitoring\.md$/);
});

test('alert webhooks are Discord channel webhooks; a loopback fake only in the local environment', () => {
  const token = 'aB3_-'.repeat(12);
  for (const ok of [`https://discord.com/api/webhooks/123456789012345678/${token}`, `https://discordapp.com/api/webhooks/123456789012345678/${token}`,
    `https://ptb.discord.com/api/webhooks/123456789012345678/${token}`, `https://canary.discord.com/api/webhooks/123456789012345678/${token}`]) {
    assert.ok(isOpsWebhookUrl(ok, 'production'), ok);
  }
  for (const bad of [undefined, '', `http://discord.com/api/webhooks/123456789012345678/${token}`, `https://discord.com.evil.test/api/webhooks/123456789012345678/${token}`,
    `https://evil.test/discord.com/api/webhooks/123456789012345678/${token}`, `https://discord.com/api/webhooks/123456789012345678/${token}?wait=false`,
    `https://discord.com/api/webhooks/123456789012345678/${token}/slack`, `https://discord.com/api/webhooks/abc/${token}`, 'https://hooks.slack.com/services/T/B/x',
    'http://127.0.0.1:4000/api/webhooks/1/fake']) {
    assert.equal(isOpsWebhookUrl(bad, 'production'), false, String(bad));
  }
  assert.ok(isOpsWebhookUrl('http://host.docker.internal:4000/api/webhooks/1/fake', 'local'));
  assert.ok(isOpsWebhookUrl('http://127.0.0.1:4000/api/webhooks/1/fake', 'local'));
  assert.equal(isOpsWebhookUrl('http://10.0.0.5:4000/api/webhooks/1/fake', 'local'), false);
  assert.equal(isOpsWebhookUrl('http://host.docker.internal:4000/api/webhooks/1/fake', 'staging'), false);
});

test('heartbeat URLs are https without credentials; loopback http only locally', () => {
  assert.ok(isOpsHeartbeatUrl('https://hc-ping.com/0f0e0d0c-0000-4000-8000-000000000001', 'production'));
  for (const bad of [undefined, 'http://hc-ping.com/x', 'https://user:pw@hc-ping.com/x', 'https://hc-ping.com/x#y', 'ftp://hc-ping.com/x', 'not a url', `https://hc-ping.com/${'x'.repeat(500)}`]) {
    assert.equal(isOpsHeartbeatUrl(bad, 'production'), false, String(bad));
  }
  assert.ok(isOpsHeartbeatUrl('http://127.0.0.1:4100/ping', 'local'));
  assert.equal(isOpsHeartbeatUrl('http://127.0.0.1:4100/ping', 'staging'), false);
});
