const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');

const root = path.resolve(path.dirname(module.filename), '../../../..');
const domain = require(path.join(root, 'packages/domain/src/crash.ts'));
const client = load(path.join(root, 'src/features/crash/crashClient.ts'), { '@picklyph/domain': domain });
const { createCrashReportHandler } = load(path.join(root, 'supabase/functions/crash-reports/handler.ts'), {}, { TextDecoder });

const plain = (value) => JSON.parse(JSON.stringify(value));
const app = { version: '0.1.0', variant: 'preview', os: 'ios', osVersion: '18.6' };
const NOW = Date.parse('2026-10-14T01:00:00.000Z');
const id = (n) => `c51d0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const build = (n, error = new TypeError(`boom ${n}`), kind = 'error', context = { route: '/play/session/c4370000-0000-4000-8000-000000000001' }, at = NOW) =>
  client.buildCrashReport(error, kind, context, app, id(n), at);
function memoryStore(initial = null) {
  const data = new Map(initial === null ? [] : [[client.CRASH_QUEUE_KEY, initial]]);
  return { data, getItem: async (key) => data.get(key) ?? null, setItem: async (key, value) => { data.set(key, value); } };
}

test('reports carry the error, the screen and the build, scrubbed and bounded, and nothing about the person', () => {
  const error = new TypeError('No booking for ana@example.com (0917 123 4567)');
  error.stack = 'TypeError: No booking for ana@example.com\n    at load (http://192.168.1.20:8081/index.bundle?platform=ios&token=x:10:20)';
  const report = plain(build(1, error, 'fatal', { route: '/rental/booking/c4370000-0000-4000-8000-000000000001?from=push' }));
  assert.deepEqual(report, { id: id(1), kind: 'fatal', name: 'TypeError', message: 'No booking for <email> (<number>)',
    stack: 'TypeError: No booking for <email>\n    at load (http://<ip>:8081/index.bundle)', component_stack: null, route: '/rental/booking/[id]',
    app_version: '0.1.0', variant: 'preview', os: 'ios', os_version: '18.6', occurred_at: '2026-10-14T01:00:00.000Z' });
  const render = plain(build(2, new Error('x'), 'render', { route: null, componentStack: '\n    in VenueSheet\n    in Screen\n' }));
  assert.equal(render.component_stack, 'in VenueSheet\n    in Screen');
  assert.equal(render.route, null);
  assert.equal(build(3, new Error('x'), 'error', { route: '/', componentStack: 'in X' }).component_stack, null, 'only render errors carry components');
  assert.deepEqual(plain(build(4, 'plain string thrown', 'error', { route: '/' })).message, 'plain string thrown');
  assert.equal(build(5, null, 'error', { route: '/' }).name, 'Error');
  assert.equal(build(6, { name: '  ', message: 5 }, 'error', { route: '/' }).name, 'Error');
  const hostile = { get name() { throw new Error('getter'); } };
  assert.equal(build(7, hostile, 'error', { route: '/' }).name, 'Error', 'an error whose fields throw still makes a report');
  const huge = new Error('m'.repeat(5000)); huge.stack = 's'.repeat(20000);
  const bounded = build(8, huge);
  assert.equal([...bounded.message].length, 500); assert.equal([...bounded.stack].length, 6000);
  assert.equal(client.buildCrashReport(new Error('x'), 'error', { route: '/' }, { ...app, version: '1.0 beta', osVersion: 'iOS 18.6 (22G86) <b>' }, id(9), NOW).app_version, '0.0.0');
  assert.equal(client.buildCrashReport(new Error('x'), 'error', { route: '/' }, { ...app, osVersion: 'iOS 18.6 (22G86) <b>' }, id(9), NOW).os_version, 'iOS 18.6 22G86 b');
  assert.equal(client.buildCrashReport(new Error('x'), 'error', { route: '/' }, app, 'not-a-uuid', NOW), null, 'nothing is recorded without a report ID');
});

test('the same error is recorded once a minute', () => {
  let now = NOW;
  const first = client.createRepeatFilter(() => now);
  const report = build(1);
  assert.equal(first(report), true);
  assert.equal(first(report), false);
  assert.equal(first({ ...report, kind: 'fatal' }), true, 'a different kind');
  assert.equal(first({ ...report, message: 'other' }), true, 'a different message');
  now += client.REPEAT_WINDOW_MS;
  assert.equal(first(report), true, 'again after a minute');
});

test('the queue keeps the newest ten reports for seven days and survives unreadable storage', async () => {
  let now = NOW;
  const store = memoryStore();
  const queue = client.createCrashQueue({ store, now: () => now, send: async () => null });
  for (let n = 1; n <= 12; n += 1) await queue.add(build(n));
  await queue.add(build(12));
  assert.deepEqual(plain(await queue.pending()).map((report) => report.id), Array.from({ length: 10 }, (_, i) => id(i + 3)), 'oldest dropped, no duplicates');
  now += 7 * 86_400_000 + 1;
  await queue.add(build(20, new Error('new'), 'error', { route: '/' }, now));
  assert.deepEqual(plain(await queue.pending()).map((report) => report.id), [id(20)], 'reports older than seven days are dropped');
  for (const broken of ['not json', '{"a":1}', JSON.stringify([{ id: 'x' }, plain(build(30))])]) {
    const reader = client.createCrashQueue({ store: memoryStore(broken), now: () => NOW, send: async () => null });
    assert.deepEqual(plain(await reader.pending()).map((report) => report.id), broken.includes(id(30)) ? [id(30)] : [], broken.slice(0, 20));
  }
  const failing = client.createCrashQueue({ store: { getItem: async () => { throw new Error('read'); }, setItem: async () => { throw new Error('write'); } }, now: () => NOW, send: async () => 200 });
  await assert.rejects(failing.add(build(40)), /write/);
  await failing.flush();
});

test('sending: oldest first; delivered and invalid reports leave the queue, anything else waits for the next try', async () => {
  const store = memoryStore();
  const replies = [200, 400, 413, 415, 503];
  const sent = [];
  const queue = client.createCrashQueue({ store, now: () => NOW, send: async (report) => { sent.push(report.id); return replies.shift() ?? null; } });
  for (let n = 1; n <= 7; n += 1) await queue.add(build(n));
  await queue.flush();
  assert.deepEqual(sent, [id(1), id(2), id(3), id(4), id(5)]);
  assert.deepEqual(plain(await queue.pending()).map((report) => report.id), [id(5), id(6), id(7)], 'a 503 stops the run and keeps the rest');
  await queue.flush();
  assert.deepEqual(plain(await queue.pending()).map((report) => report.id), [id(5), id(6), id(7)], 'no answer keeps everything');
  for (const status of [429, 404, 500]) {
    replies.push(status);
    await queue.flush();
    assert.equal(plain(await queue.pending()).length, 3, `${status} keeps the report`);
  }
  const thrower = client.createCrashQueue({ store: memoryStore(), now: () => NOW, send: async () => { throw new Error('offline'); } });
  await thrower.add(build(9)); await thrower.flush();
  assert.equal(plain(await thrower.pending()).length, 1, 'a failed send keeps the report');
});

test('one flush at a time, and a report saved during a send is kept', async () => {
  const store = memoryStore();
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  const queue = client.createCrashQueue({ store, now: () => NOW, send: async () => { sends += 1; await gate; return 200; } });
  await queue.add(build(1));
  const first = queue.flush();
  const second = queue.flush();
  assert.equal(first, second, 'the same flush');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await queue.add(build(2));
  release();
  await first;
  assert.equal(sends, 2, 'the report saved during the send went out in the same run');
  assert.deepEqual(plain(await queue.pending()), []);
});

test('the global handler records, then hands every error on; a fatal one only after its report is saved', async () => {
  const calls = [];
  const previous = (error, fatal) => calls.push(['previous', error.message, fatal]);
  let handler = previous;
  const utils = { getGlobalHandler: () => handler, setGlobalHandler: (next) => { handler = next; } };
  let finishSave;
  const uninstall = client.installCrashHandler(utils, (error, fatal) => {
    calls.push(['record', error.message, fatal]);
    return fatal ? new Promise((resolve) => { finishSave = resolve; }) : Promise.resolve();
  });
  handler(new Error('soft'), false);
  assert.deepEqual(calls, [['record', 'soft', false], ['previous', 'soft', false]], 'non-fatal errors pass straight on');
  calls.length = 0;
  handler(new Error('hard'), true);
  assert.deepEqual(calls, [['record', 'hard', true]], 'a fatal error waits for its report');
  finishSave();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [['record', 'hard', true], ['previous', 'hard', true]]);
  uninstall();
  assert.equal(handler, previous, 'uninstall restores React Native\'s handler');
});

test('a fatal report that never saves still lets the app end after the wait; recording failures never swallow the error', async () => {
  const calls = [];
  let handler = (error, fatal) => calls.push(['previous', error.message, fatal]);
  const utils = { getGlobalHandler: () => handler, setGlobalHandler: (next) => { handler = next; } };
  const timers = { pending: [], setTimeout: (fn, ms) => { timers.pending.push([fn, ms]); return timers.pending.length; }, clearTimeout: () => {} };
  client.installCrashHandler(utils, () => new Promise(() => {}), client.FATAL_SAVE_MS, timers);
  handler(new Error('stuck'), true);
  assert.deepEqual(calls, []);
  assert.equal(timers.pending[0][1], 1500);
  timers.pending[0][0]();
  timers.pending[0][0]();
  assert.deepEqual(calls, [['previous', 'stuck', true]], 'passed on once when the wait runs out');

  const seen = [];
  let inner = (error, fatal) => seen.push(['previous', error.message, fatal]);
  const innerUtils = { getGlobalHandler: () => inner, setGlobalHandler: (next) => { inner = next; } };
  client.installCrashHandler(innerUtils, (error) => {
    seen.push(['record', error.message]);
    if (error.message === 'outer') inner(new Error('while recording'), false);
    throw new Error('recorder broke');
  });
  inner(new Error('outer'), false);
  assert.deepEqual(seen, [['record', 'outer'], ['previous', 'while recording', false], ['previous', 'outer', false]],
    'an error raised while recording is passed on unrecorded, and a broken recorder never hides the original');
  seen.length = 0;
  inner(new Error('rejected'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [['record', 'rejected'], ['previous', 'rejected', true]], 'a fatal error whose recorder throws is passed on at once');
});

test('the shipped queue against the real function handler: stored once with the server fingerprint, invalid reports dropped', async () => {
  const stored = new Map();
  const handler = createCrashReportHandler({ guestSource: () => 'unknown', limit: async () => ({ allowed: true, status: 200, state: 'enforced', headers: {} }),
    record: async (report) => { const outcome = stored.has(report.id) ? 'existing' : 'stored'; stored.set(report.id, plain(report)); return outcome; } });
  const requests = [];
  const send = async (report) => {
    const response = await handler(new Request('https://crash.local/functions/v1/crash-reports', { method: 'POST',
      headers: { apikey: 'sb_publishable_test', 'Content-Type': 'application/json' }, body: JSON.stringify(report) }));
    requests.push(response.status);
    return response.status;
  };
  const queue = client.createCrashQueue({ store: memoryStore(), now: () => NOW, send });
  await queue.add(build(1));
  const forged = { ...plain(build(2)), account: 'a@b.co' };
  const store = memoryStore(JSON.stringify([plain(build(1)), forged, plain(build(3, new Error('x'), 'render', { route: '/', componentStack: 'in A' }))]));
  const mixed = client.createCrashQueue({ store, now: () => NOW, send });
  await queue.flush(); await mixed.flush();
  assert.deepEqual(requests, [200, 200, 200], 'the unreadable entry never left the phone');
  assert.deepEqual([...stored.keys()].sort(), [id(1), id(3)]);
  assert.match(stored.get(id(1)).fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(stored.get(id(3)).component_stack, 'in A');
  assert.deepEqual(plain(await queue.pending()), []); assert.deepEqual(plain(await mixed.pending()), []);
});
