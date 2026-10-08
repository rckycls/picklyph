const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const load = require('../../../../supabase/tests/load-ts.cjs');

const root = path.resolve(path.dirname(module.filename), '../../../..');
const domain = { ...require(path.join(root, 'packages/domain/src/moderation.ts')), ...require(path.join(root, 'packages/domain/src/booking.ts')) };
const client = load(path.join(root, 'src/features/discovery/reportClient.ts'), { '@picklyph/domain': domain, '../owner/venueClient': require(path.join(root, 'src/features/owner/venueClient.ts')) });
const handlerModule = load(path.join(root, 'supabase/functions/venue-reports/handler.ts'), {}, { TextDecoder });

const actor = 'c4690000-0000-4000-8000-000000000001';
const venue = 'c4690000-0000-4000-8000-000000000002';
const key = 'c4690000-0000-4000-8000-000000000003';
const plain = (value) => JSON.parse(JSON.stringify(value));
const draft = (details = '  Gates locked\r\nsince May ') => client.reportDraft({ requestId: key, venueId: venue, reason: 'closed', details });
const stored = (body, patch = {}) => ({ id: 'c4690000-0000-4000-8000-000000000004', venue_id: body.venue_id, reason: body.reason, details: body.details,
  status: 'open', created_at: '2026-10-09T05:00:00.123456+00:00', ...patch });
/** The real handler with a fake database; `reply` decides what the database returns. */
const served = (reply) => {
  const calls = [];
  const handler = handlerModule.createVenueReportHandler({ verifyUser: async (token) => token === 'token' ? actor : null,
    limit: async () => ({ allowed: true, status: 200, state: 'enforced', headers: {} }),
    submit: async (who, report) => { calls.push(plain([who, report])); return reply(report); } });
  const transport = { endpoint: 'https://reports.local', apiKey: 'public', accessToken: async () => 'token', fetch: (url, init) => handler(new Request(url, init)) };
  return { calls, transport };
};

test('the form becomes one canonical body: trimmed, CRLF normalized, empty details omitted, nothing else', () => {
  assert.deepEqual(plain(draft()), { request_id: key, venue_id: venue, reason: 'closed', details: 'Gates locked\nsince May' });
  assert.equal(draft('   ').details, null);
  assert.throws(() => draft('x'.repeat(501)), domain.ModerationInputError);
  assert.throws(() => draft('bell\u0007'), domain.ModerationInputError);
});

test('a sent report round-trips through the real handler with no caller authority', async () => {
  const { calls, transport } = served((report) => ({ outcome: 'created', report: stored(report) }));
  const outcome = await client.submitReport(transport, draft());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value.report.created_at, '2026-10-09T05:00:00.123Z');
  assert.deepEqual(calls, [[actor, plain(draft())]]);
});

test('a success that describes another report is treated as uncertain, so the same key is retried', async () => {
  for (const patch of [{ venue_id: key }, { reason: 'unsafe' }, { details: null }, { status: 'deleted' }, { id: 'x' }, { created_at: '2026-10-09 05:00' }]) {
    const { transport } = served((report) => ({ outcome: 'existing', report: stored(report, patch) }));
    const outcome = await client.submitReport(transport, draft());
    assert.equal(outcome.ok, false, JSON.stringify(patch));
    assert.equal(outcome.failure.kind, 'unavailable');
  }
  const { transport } = served((report) => ({ outcome: 'queued', report: stored(report) }));
  assert.equal((await client.submitReport(transport, draft())).failure.kind, 'unavailable');
});

test('refusals become readable messages; lost replies say a retry is safe', async () => {
  for (const reason of ['already_reported', 'venue_unavailable', 'too_many_reports', 'request_reused', 'account_required']) {
    const { transport } = served(() => { throw new handlerModule.ReportRejected(reason); });
    const outcome = await client.submitReport(transport, draft());
    assert.deepEqual(plain(outcome.failure), { kind: 'rejected', reason, retryAfterSeconds: null });
    assert.ok(client.reportFailureMessage(outcome.failure).length > 10);
  }
  const lost = { endpoint: 'https://reports.local', apiKey: 'public', accessToken: async () => 'token', fetch: async () => { throw new Error('Lost reply'); } };
  const failure = (await client.submitReport(lost, draft())).failure;
  assert.equal(failure.kind, 'network');
  assert.match(client.reportFailureMessage(failure), /won’t create a duplicate/);
  const signedOut = { ...lost, accessToken: async () => null };
  assert.equal((await client.submitReport(signedOut, draft())).failure.kind, 'sign_in');
});
