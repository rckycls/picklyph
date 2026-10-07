const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const load = require('../../../../supabase/tests/load-ts.cjs');
const hookDriver = require('./hookDriver.cjs');
const here = path.dirname(module.filename);

test('600ms loading delay cancels for fast or superseded requests and never decorates load-more', () => {
  const d = hookDriver(); const timers = new Map(); let timerId = 0;
  let status = 'loading'; let count = 0; let requestId = 1;
  const { useDiscoveryMascot } = load(path.join(here, '../useDiscoveryMascot.ts'), {
    react: d.react, './presentation': load(path.join(here, '../presentation.ts')),
  }, { setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  try {
    assert.equal(d.start(() => useDiscoveryMascot(status, count, requestId)), null);
    assert.equal(timers.size, 1); const first = [...timers.values()][0]; assert.equal(first.ms, 600);
    requestId = 2; d.rerender(); assert.equal(timers.size, 1);
    first.fn(); assert.equal(d.flush(), null); // Even a late fired callback belongs to the previous request.
    [...timers.values()][0].fn(); assert.equal(d.flush(), 'thinking');
    status = 'ready'; count = 2; assert.equal(d.rerender(), null); assert.equal(timers.size, 0);
    requestId = 3; status = 'loading'; assert.equal(d.rerender(), null); assert.equal(timers.size, 0);
    count = 0; requestId = 4; d.rerender(); assert.equal(timers.size, 1);
    status = 'ready'; assert.equal(d.rerender(), 'idle'); assert.equal(timers.size, 0);
    status = 'error'; assert.equal(d.rerender(), 'oops'); assert.equal(timers.size, 0);
  } finally { d.close(); }
});
