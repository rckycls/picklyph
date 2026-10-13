const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MONITOR_STALE_MINUTES, agoText, checkRows, jobStateLabel, monitorFreshness, problemCounts } = require('../src/lib/health.ts');
const { OPS_CHECK_NAMES, OPS_JOBS, readOpsAdminView } = require('@picklyph/domain/src/ops.ts');

const at = '2026-10-13T13:00:00.000Z';
const minutesBefore = (n) => new Date(Date.parse(at) - n * 60_000).toISOString();
const sqlChecks = (patch = {}) => OPS_CHECK_NAMES.filter((name) => !name.startsWith('redis.'))
  .map((check) => ({ check, status: 'ok', count: 0, ...patch[check] }));
const state = (check, status, extra = {}) => ({ check, status, count: status === 'ok' ? 0 : 1, since: minutesBefore(60), checked_at: minutesBefore(2),
  notified_status: null, notified_at: null, ...extra });
const job = (name, extra = {}) => ({ job: name, present: true, active: true, schedule: '* * * * *', last_run_at: null, last_status: null,
  last_success_at: null, failures: 0, last_failure_at: null, last_failure: null, ...extra });
// Through the domain reader, as the page gets it.
const view = (patch = {}) => readOpsAdminView({ at, checks: sqlChecks(), state: [], monitor_ran_at: minutesBefore(2), jobs: OPS_JOBS.map((name) => job(name)),
  signals: [], ...patch });

test('monitor freshness by the database clock: never, current within 15 minutes, stopped after', () => {
  assert.deepEqual(monitorFreshness(view({ monitor_ran_at: null })), { state: 'never' });
  assert.deepEqual(monitorFreshness(view()), { state: 'current', minutes: 2, ranAt: minutesBefore(2) });
  assert.equal(monitorFreshness(view({ monitor_ran_at: minutesBefore(MONITOR_STALE_MINUTES) })).state, 'current', 'exactly 15 minutes is still current');
  assert.deepEqual(monitorFreshness(view({ monitor_ran_at: minutesBefore(MONITOR_STALE_MINUTES + 1) })), { state: 'stale', minutes: 16, ranAt: minutesBefore(16) });
  assert.equal(monitorFreshness(view({ monitor_ran_at: '2026-10-13T13:00:05.000Z' })).minutes, 0, 'clock skew is never negative');
  assert.deepEqual([0, 1, 7, 119, 120, 47 * 60, 48 * 60, 10 * 24 * 60].map(agoText), ['less than a minute ago', '1 minute ago', '7 minutes ago', '119 minutes ago',
    '2 hours ago', '47 hours ago', '2 days ago', '10 days ago']);
});

test('check rows: every known check in report order with the monitor\'s wording, Redis from the monitor, unknown names last', () => {
  const rows = checkRows(view({
    checks: [...sqlChecks({ 'holds.overdue': { status: 'fail', count: 2 }, 'edge.errors': { status: 'warn', count: 3 } }), { check: 'future.check', status: 'warn', count: 4 }],
    state: [state('redis.reachable', 'fail', { notified_status: 'fail', notified_at: minutesBefore(30) }), state('holds.overdue', 'fail'), state('old.check', 'ok')],
  }));
  assert.deepEqual(rows.map((row) => row.check), [...OPS_CHECK_NAMES, 'future.check', 'old.check']);
  const row = (name) => rows.find((item) => item.check === name);
  assert.deepEqual({ ...row('holds.overdue'), monitor: row('holds.overdue').monitor.status },
    { check: 'holds.overdue', label: 'Hold sweep', live: 'fail', text: '2 elapsed holds are still pending after 10 minutes', monitor: 'fail' });
  assert.equal(row('edge.errors').text, '3 server errors in the last 15 minutes');
  assert.equal(row('push.backlog').text, '', 'ok checks need no words');
  assert.deepEqual([row('redis.reachable').live, row('redis.reachable').text], [null, 'Checked by the monitor only: not reachable or not configured from the monitor']);
  assert.deepEqual([row('redis.isolation').live, row('redis.isolation').text, row('redis.isolation').monitor], [null, 'Checked by the monitor only.', null]);
  assert.deepEqual([row('future.check').label, row('future.check').text], ['future.check', 'count 4']);
  assert.equal(row('old.check').text, 'Not checked on this database.');
  assert.deepEqual(problemCounts(view({
    checks: sqlChecks({ 'holds.overdue': { status: 'fail', count: 2 }, 'edge.errors': { status: 'warn', count: 3 } }),
    state: [state('redis.reachable', 'fail'), state('redis.isolation', 'warn'), state('holds.overdue', 'ok'), state('push.backlog', 'fail')],
  })), { fail: 2, warn: 2 }, 'live wins for database checks (a stale monitor failure is not counted); Redis comes from the monitor');
  assert.deepEqual(problemCounts(view()), { fail: 0, warn: 0 });
});

test('without pg_cron the run checks say so; job states read missing, inactive or active', () => {
  const rows = checkRows(view({ jobs: null, checks: sqlChecks({ 'cron.jobs': { status: 'fail', count: 5 } }).filter((c) => !['cron.failures', 'cron.stalled'].includes(c.check)) }));
  assert.equal(rows.find((row) => row.check === 'cron.failures').text, 'pg_cron is off, so there are no job runs to check.');
  assert.equal(rows.find((row) => row.check === 'cron.jobs').live, 'fail');
  assert.deepEqual([job('ops-monitor', { present: false, active: false }), job('ops-monitor', { active: false }), job('ops-monitor')].map(jobStateLabel), ['Missing', 'Inactive', 'Active']);
});
