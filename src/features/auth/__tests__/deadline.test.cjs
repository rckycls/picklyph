const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const compiled = ts.transpileModule(fs.readFileSync(path.resolve(path.dirname(module.filename), '../../../lib/fetchWithDeadline.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
function harness(fetch) {
  let deadline;
  let cleared = false;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, fetch, AbortController, Request,
    setTimeout: (callback, ms) => { assert.equal(ms, 15000); deadline = callback; return 1; },
    clearTimeout: () => { cleared = true; },
  });
  return { request: module.exports.fetchWithDeadline, expire: () => deadline(), cleared: () => cleared };
}
const waitsForAbort = (_input, { signal }) => new Promise((_, reject) => {
  if (signal.aborted) reject(new Error('cancelled'));
  else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
});

test('network deadline aborts a stalled auth request and clears its timer', async () => {
  const h = harness(waitsForAbort);
  const pending = h.request('https://example.invalid');
  h.expire();
  await assert.rejects(pending, /cancelled/);
  assert.equal(h.cleared(), true);
});

test('caller cancellation survives Request and init forms; success clears its timer', async () => {
  for (const requestForm of [false, true]) {
    const controller = new AbortController();
    const h = harness(waitsForAbort);
    const pending = requestForm
      ? h.request(new Request('https://example.invalid', { signal: controller.signal }))
      : h.request('https://example.invalid', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(h.cleared(), true);
  }
  const h = harness(async () => 'response');
  assert.equal(await h.request('https://example.invalid'), 'response');
  assert.equal(h.cleared(), true);
});
