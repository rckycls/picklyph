const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('./load-ts.cjs');

const handlerModule = load(path.join(__dirname, '../functions/crash-reports/handler.ts'), {}, { TextDecoder });
const { createCrashReportHandler, CrashRejected } = handlerModule;
const { createSupabaseCrashDeps } = load(path.join(__dirname, '../functions/crash-reports/deps.ts'), { './handler.ts': handlerModule });
const { createRateGuard, RATE_POLICIES } = load(path.join(__dirname, '../functions/_shared/rate-limit.ts'));
const { MAX_CRASH_BYTES } = require('../../packages/domain/src/crash.ts');

const plain = (value) => JSON.parse(JSON.stringify(value));
const allowed = { allowed: true, status: 200, state: 'enforced', headers: { 'X-RateLimit-Remaining': '19' } };
const report = (patch = {}) => ({ id: 'c51d0000-0000-4000-8000-000000000001', kind: 'fatal', name: 'TypeError', message: 'No venue for ana@example.com',
  stack: 'TypeError: x\n    at a (index.bundle:1:100)', component_stack: null, route: '/rental/venue/[id]', app_version: '0.1.0', variant: 'preview',
  os: 'ios', os_version: '18.6', occurred_at: '2026-10-14T01:02:03.456Z', ...patch });
const post = (body = report(), headers = {}) => new Request('https://crash.local/functions/v1/crash-reports', { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
function setup(overrides = {}) {
  const calls = { limit: [], record: [] };
  const handler = createCrashReportHandler({ guestSource: () => 'trusted-source',
    limit: async (action, principal) => { calls.limit.push([action, plain(principal)]); return allowed; },
    record: async (item) => { calls.record.push(plain(item)); return 'stored'; }, ...overrides });
  return { handler, calls };
}

test('reports are anonymous: a guest bucket by ingress source, no bearer read, stored scrubbed with the server fingerprint', async () => {
  const { handler, calls } = setup();
  const response = await handler(post(report(), { authorization: 'Bearer forged-or-real', 'x-forwarded-for': '1.2.3.4' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.equal(response.headers.get('X-RateLimit-Remaining'), '19');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(calls.limit, [['crash-report', { kind: 'guest', id: 'trusted-source' }]]);
  assert.equal(calls.record.length, 1);
  const { fingerprint, ...stored } = calls.record[0];
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(stored, { ...report(), message: 'No venue for <email>' }, 'scrubbed again on the server');
  await handler(post(report({ id: 'c51d0000-0000-4000-8000-000000000002', message: 'No venue for bo@example.com' })));
  assert.equal(calls.record[1].fingerprint, fingerprint, 'the same crash groups together');
});

test('method, query, media type, size and shape are refused before anything is stored', async () => {
  const { handler, calls } = setup();
  const statuses = [];
  statuses.push((await handler(new Request('https://crash.local/functions/v1/crash-reports'))).status);
  statuses.push((await handler(new Request('https://crash.local/functions/v1/crash-reports?id=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status);
  statuses.push((await handler(post(report(), { 'content-type': 'text/plain' }))).status);
  statuses.push((await handler(post(report(), { 'content-length': String(MAX_CRASH_BYTES + 1) }))).status);
  statuses.push((await handler(post(report(), { 'content-length': 'abc' }))).status);
  assert.deepEqual(statuses, [405, 400, 415, 413, 413]);
  assert.equal(calls.limit.length, 0, 'cheap refusals spend no allowance');
  assert.equal((await handler(post(report({ stack: 's'.repeat(MAX_CRASH_BYTES) })))).status, 413, 'a streamed body over the limit');
  for (const body of ['not json', '[]', { ...report(), account: 'x' }, report({ kind: 'warning' }), report({ name: '' }), report({ component_stack: 'in X' }),
    'ÿ'.repeat(3)]) {
    const response = await handler(post(body));
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(await response.json(), { error: 'invalid_report' });
  }
  assert.equal(calls.record.length, 0);
  assert.equal(calls.limit.length, 8, 'the allowance is spent before the body is read');
});

test('limits, outages and storage failures: the app keeps the report unless it was refused as invalid', async () => {
  const limited = setup({ limit: async () => ({ allowed: false, status: 429, state: 'enforced', headers: { 'Retry-After': '30' } }) });
  const tooMany = await limited.handler(post());
  assert.equal(tooMany.status, 429); assert.equal(tooMany.headers.get('Retry-After'), '30'); assert.equal(limited.calls.record.length, 0);
  const broken = setup({ limit: async () => { throw new Error('principal'); } });
  assert.equal((await broken.handler(post())).status, 503);
  // Redis down: crash reports follow the "continue" policy and are still stored.
  const degraded = setup({ limit: async () => ({ allowed: true, status: 200, state: 'degraded', headers: {} }) });
  assert.equal((await degraded.handler(post())).status, 200); assert.equal(degraded.calls.record.length, 1);
  const unavailable = setup({ record: async () => { throw new Error('database'); } });
  const down = await unavailable.handler(post());
  assert.equal(down.status, 503); assert.equal(down.headers.get('Retry-After'), '5');
  const refused = setup({ record: async () => { throw new CrashRejected(); } });
  assert.equal((await refused.handler(post())).status, 400);
  for (const outcome of ['existing', 'capped']) assert.equal((await setup({ record: async () => outcome }).handler(post())).status, 200, outcome);
});

test('the database adapter calls crash_report_record and reads its outcome strictly', async () => {
  const replies = [{ data: { outcome: 'stored' }, error: null }, { data: { outcome: 'existing' }, error: null }, { data: { outcome: 'capped' }, error: null },
    { data: null, error: { hint: 'invalid_input', message: 'Invalid crash report' } }, { data: { outcome: 'weird' }, error: null },
    { data: null, error: { message: 'timeout' } }];
  const calls = [];
  const deps = createSupabaseCrashDeps(() => ({ rpc: async (name, args) => { calls.push([name, plain(args)]); return replies.shift(); } }));
  const record = { ...report(), fingerprint: 'a'.repeat(64) };
  assert.equal(await deps.record(record), 'stored');
  assert.equal(await deps.record(record), 'existing');
  assert.equal(await deps.record(record), 'capped');
  await assert.rejects(deps.record(record), (error) => error instanceof CrashRejected);
  await assert.rejects(deps.record(record), (error) => !(error instanceof CrashRejected));
  await assert.rejects(deps.record(record), (error) => !(error instanceof CrashRejected));
  assert.deepEqual(calls[0], ['crash_report_record', { report: record }]);
});

test('the crash-report bucket is guest-only, 20 a minute, and continues in a Redis outage', async () => {
  assert.deepEqual(plain(RATE_POLICIES['crash-report']), { user: 0, guest: 20, outage: 'continue' });
  const seen = [];
  const guard = createRateGuard({ identifier: async (principal) => `${principal.kind}:${principal.id}`,
    backend: async (action, principal, identifier) => { seen.push([action, identifier]); return { success: true, limit: 20, remaining: 19, reset: Date.now() + 60000 }; } });
  assert.equal((await guard('crash-report', { kind: 'guest', id: 'unknown' })).state, 'enforced');
  assert.deepEqual(seen, [['crash-report', 'guest:unknown']]);
  await assert.rejects(guard('crash-report', { kind: 'user', id: 'verified' }), /verified principal/);
  await assert.rejects(guard('crash-report', { kind: 'provider', id: 'x' }), /verified principal/);
  const down = createRateGuard({ identifier: async () => 'x', backend: async () => { throw new Error('redis'); } });
  assert.deepEqual(plain(await down('crash-report', { kind: 'guest', id: 'unknown' })), { allowed: true, status: 200, state: 'degraded', headers: {} });
  await assert.rejects(guard('hold-create', { kind: 'guest', id: 'unknown' }), /verified principal/, 'other actions still need an account');
});
