const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { load, booking } = require('./helpers.cjs');

// Small deterministic hook driver: runs the shipped focus/foreground hook, without a browser or native UI claim.
function driver(initialRead, refreshSeconds) {
  const slots = []; let index = 0; let dirty = true; let result; let read = initialRead;
  let focused = true; let focusCallback; let pendingFocus; let cleanup;
  const listeners = new Set(); const timers = new Map(); let timerId = 0;
  const same = (a, b) => a?.length === b.length && b.every((v, i) => Object.is(v, a[i]));
  const react = {
    useState(initial) { const at = index++; if (!slots[at]) slots[at] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[at].value, next => { const value = typeof next === 'function' ? next(slots[at].value) : next; if (!Object.is(value, slots[at].value)) { slots[at].value = value; dirty = true; } }]; },
    useRef(initial) { const at = index++; return slots[at] ??= { current: initial }; },
    useCallback(fn, deps) { const at = index++; if (!slots[at] || !same(slots[at].deps, deps)) slots[at] = { fn, deps }; return slots[at].fn; },
  };
  const { useRentalRead: renderHook } = load(path.join(path.dirname(module.filename), '../useRentalRead.ts'), {
    react, 'expo-router': { useFocusEffect(fn) { if (fn !== focusCallback) { focusCallback = fn; pendingFocus = fn; } } },
    'react-native': { AppState: { addEventListener: (_, fn) => { listeners.add(fn); return { remove: () => listeners.delete(fn) }; } } },
  }, { AbortController, setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  const flush = () => { let loops = 0; while (dirty || pendingFocus) {
    if (++loops > 50) throw new Error('Hook did not settle');
    if (dirty) { dirty = false; index = 0; result = renderHook(read, refreshSeconds); }
    if (pendingFocus) { const fn = pendingFocus; pendingFocus = null; cleanup?.(); cleanup = focused ? fn() : undefined; }
  } return result; };
  const settle = async () => { await new Promise(r => setImmediate(r)); flush(); await new Promise(r => setImmediate(r)); return flush(); };
  flush();
  return { flush, settle, timers, listeners,
    changeRead(next) { read = next; dirty = true; return flush(); },
    foreground() { for (const fn of [...listeners]) fn('active'); return flush(); },
    blur() { focused = false; cleanup?.(); cleanup = undefined; },
    focus() { focused = true; cleanup = focusCallback(); return flush(); },
    close() { cleanup?.(); },
  };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('refresh ignores a late pending record and keeps the newer authoritative cancellation', async () => {
  const replies = []; const signals = [];
  const d = driver(signal => { const reply = deferred(); replies.push(reply); signals.push(signal); return reply.promise; });
  try {
    assert.equal(d.flush().busy, true); d.flush().refresh(); d.flush();
    assert.equal(signals[0].aborted, true); assert.equal(replies.length, 2);
    replies[1].resolve({ ok: true, value: booking('cancelled') }); await d.settle();
    assert.equal(d.flush().value.status, 'cancelled');
    replies[0].resolve({ ok: true, value: booking('pending') }); await d.settle();
    assert.equal(d.flush().value.status, 'cancelled'); assert.equal(d.flush().busy, false);
  } finally { d.close(); }
});
test('identity/read change aborts the old request; foreground revalidates retained details', async () => {
  const first = deferred(); const second = deferred(); let oldSignal; let calls = 0;
  const d = driver(signal => { oldSignal = signal; return first.promise; });
  try {
    d.changeRead(async () => { calls++; return calls === 1 ? second.promise : { ok: false, failure: { kind: 'sign_in', retryAfterSeconds: null } }; });
    assert.equal(oldSignal.aborted, true);
    second.resolve({ ok: true, value: booking('expired') }); await d.settle();
    first.resolve({ ok: true, value: booking('confirmed') }); await d.settle();
    assert.equal(d.flush().value.status, 'expired');
    d.foreground(); assert.equal(d.flush().busy, true); await d.settle();
    assert.equal(calls, 2); assert.equal(d.flush().failure.kind, 'sign_in'); assert.equal(d.flush().value.status, 'expired');
  } finally { d.close(); }
});
test('blur suppresses late reads and removes listeners; polling queries the server without local expiry projection', async () => {
  const replies = []; const d = driver(async () => { const reply = deferred(); replies.push(reply); return reply.promise; }, 30);
  try {
    replies[0].resolve({ ok: true, value: booking('pending') }); await d.settle();
    assert.equal(d.flush().value.status, 'pending');
    const timer = [...d.timers.values()][0]; assert.equal(timer.ms, 30000); timer.fn(); d.flush();
    assert.equal(d.flush().value.status, 'pending'); assert.equal(d.flush().busy, true);
    replies[1].resolve({ ok: true, value: booking('expired') }); await d.settle(); assert.equal(d.flush().value.status, 'expired');
    d.flush().refresh(); d.flush(); d.blur(); assert.equal(d.listeners.size, 0); assert.equal(d.timers.size, 0);
    replies[2].resolve({ ok: true, value: booking('confirmed') }); await d.settle(); assert.equal(d.flush().value.status, 'expired');
  } finally { d.close(); }
});
test('automatic status refresh respects a longer server retry delay', async () => {
  const d = driver(async () => ({ ok: false, failure: { kind: 'rate_limited', retryAfterSeconds: 120 } }), 30);
  try { await d.settle(); assert.equal([...d.timers.values()][0].ms, 120000); assert.equal(d.flush().failure.kind, 'rate_limited'); }
  finally { d.close(); }
});
