const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const load = require('../../../../supabase/tests/load-ts.cjs');
const hookDriver = require('./hookDriver.cjs');
const here = path.dirname(module.filename);

function clock(playback = 'loop', initialReduced = false) {
  const driver = hookDriver(); let focused = true;
  const apps = new Set(); const reductions = new Set();
  const frame = { active: false, callback: null, setActive(value) { this.active = value; } };
  const reanimated = {
    useReducedMotion: () => initialReduced,
    useSharedValue(initial) { const ref = driver.react.useRef({ value: initial });
      return Object.assign(ref.current, { get() { return this.value; }, set(value) { this.value = value; } }); },
    useFrameCallback(fn) { frame.callback = fn; return frame; },
    runOnJS: fn => fn,
  };
  const listen = set => (_, fn) => { set.add(fn); return { remove: () => set.delete(fn) }; };
  const { useMascotClock } = load(path.join(here, '../useMascotClock.ts'), {
    './motion': load(path.join(here, '../motion.ts')),
    react: driver.react, 'expo-router': { useIsFocused: () => focused }, 'react-native-reanimated': reanimated,
    'react-native': { AppState: { currentState: 'active', addEventListener: listen(apps) },
      AccessibilityInfo: { addEventListener: listen(reductions), isReduceMotionEnabled: async () => initialReduced } },
  });
  driver.start(() => useMascotClock('cheer', playback));
  return { ...driver, frame, apps, reductions,
    advance(ms) { if (frame.active) frame.callback({ timeSincePreviousFrame: ms }); return driver.flush(); },
    focus(value) { focused = value; return driver.rerender(); },
    foreground(value) { for (const fn of apps) fn(value ? 'active' : 'background'); return driver.flush(); },
    reduce(value) { for (const fn of reductions) fn(value); return driver.flush(); },
  };
}

test('focus and app lifecycle freeze the clock and resume without crediting hidden time', async () => {
  const d = clock();
  try {
    await d.settle(); assert.equal(d.advance(400).elapsed.get(), 400);
    d.focus(false); assert.equal(d.frame.active, false); assert.equal(d.advance(9000).elapsed.get(), 400);
    d.focus(true); assert.equal(d.advance(100).elapsed.get(), 500);
    d.foreground(false); assert.equal(d.advance(9000).elapsed.get(), 500);
    d.foreground(true); assert.equal(d.advance(100).elapsed.get(), 600);
  } finally { d.close(); }
  assert.equal(d.frame.active, false); assert.equal(d.apps.size, 0); assert.equal(d.reductions.size, 0);
});

test('once playback stops after three 1.1-second cheer cycles and never restarts on focus', async () => {
  const d = clock('once');
  try {
    await d.settle(); assert.equal(d.advance(3299).finished, false);
    assert.equal(d.advance(100).elapsed.get(), 3300); assert.equal(d.flush().finished, true);
    assert.equal(d.frame.active, false); d.focus(false); d.focus(true);
    assert.equal(d.advance(10000).elapsed.get(), 3300);
  } finally { d.close(); }
});

test('Reduce Motion responds to live setting changes; static playback never starts a frame callback', async () => {
  const d = clock('loop', true);
  try {
    await d.settle(); assert.equal(d.frame.active, false); assert.equal(d.flush().animated, false);
    d.reduce(false); assert.equal(d.advance(500).elapsed.get(), 500);
    d.reduce(true); assert.equal(d.flush().animated, false); assert.equal(d.advance(500).elapsed.get(), 500);
  } finally { d.close(); }
  const still = clock('static');
  try { await still.settle(); assert.equal(still.frame.active, false); assert.equal(still.advance(500).elapsed.get(), 0); }
  finally { still.close(); }
});
