import assert from 'node:assert/strict';
import { buildUpstashGuard } from '../_shared/upstash.ts';
import { createSearchHandler } from '../venue-search/handler.ts';

const env: Record<string, string> = {
  PICKLY_ENV: 'local', UPSTASH_REDIS_REST_URL: 'https://fixture.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'in-memory-test-token', RATE_LIMIT_KEY_SECRET: 'in-memory-test-key-secret-minimum-32',
};

Deno.test('pinned real Upstash SDK adapter interprets REST denial, sanitizes errors and catches SDK fail-open timeout', async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  try {
    globalThis.fetch = (_input, init) => {
      requests.push(String(init?.body));
      const command = JSON.parse(String(init?.body));
      const reply = { result: [-1, 30] };
      return Promise.resolve(new Response(JSON.stringify(Array.isArray(command[0]) ? command.map(() => reply) : reply), { status: 200 }));
    };
    const guard = buildUpstashGuard((name) => env[name]);
    const denied = await guard('discovery', { kind: 'guest', id: '203.0.113.10' });
    assert.equal(denied.status, 429);
    assert.ok(Number(denied.headers['Retry-After']) >= 1);
    assert.ok(requests.length > 0 && requests.every((body) => !body.includes('203.0.113.10')));
    let searched = false;
    const handler = createSearchHandler({
      verifyUser: () => Promise.resolve(null), guestSource: () => '203.0.113.10',
      limit: (principal) => guard('discovery', principal),
      search: () => { searched = true; return Promise.resolve({ venues: [], next_cursor: null }); },
    });
    const response = await handler(new Request('https://test.local/venue-search?city=Manila'));
    assert.equal(response.status, 429); assert.ok(Number(response.headers.get('Retry-After')) >= 1);
    assert.equal(searched, false, 'Actual SDK denial must precede DB work');
    globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ error: 'in-memory Redis failure' }), { status: 500 }));
    assert.equal((await guard('hold-create', { kind: 'user', id: 'verified-id' })).status, 503);
    assert.equal((await guard('cancel', { kind: 'user', id: 'verified-id' })).allowed, true);
    const pending: Promise<void>[] = [];
    globalThis.fetch = (_input, init) => new Promise<Response>((resolve) => {
      const completion = new Promise<void>((done) => setTimeout(() => {
        const command = JSON.parse(String(init?.body));
        const reply = { result: [9, 10] };
        resolve(new Response(JSON.stringify(Array.isArray(command[0]) ? command.map(() => reply) : reply), { status: 200 })); done();
      }, 700));
      pending.push(completion);
    });
    // Uses the SDK's actual timeout650 response (success:true, reason:timeout).
    assert.equal((await guard('checkout-create', { kind: 'user', id: 'verified-id' })).status, 503);
    await Promise.all(pending);
  } finally { globalThis.fetch = original; }
});
