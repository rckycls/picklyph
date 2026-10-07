const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const load = require('../../../../supabase/tests/load-ts.cjs');
const here = path.dirname(module.filename);
const { discoveryMascotPose } = load(path.join(here, '../presentation.ts'));
const { motionFrame } = load(path.join(here, '../motion.ts'));
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.001, `${a} differs from ${b}`);

test('discovery separates empty, loading and errors while keeping retained/paginated results clear', () => {
  assert.equal(discoveryMascotPose('loading', 0, false), null);
  assert.equal(discoveryMascotPose('loading', 0, true), 'thinking');
  assert.equal(discoveryMascotPose('ready', 0, false), 'idle');
  assert.equal(discoveryMascotPose('error', 0, true), 'oops');
  for (const status of ['loading', 'ready', 'error']) assert.equal(discoveryMascotPose(status, 25, true), null);
});

test('native transforms preserve reference timing and amplitudes at key landmarks', () => {
  close(motionFrame('bob', 1200, true).matrix[5], -6);
  close(motionFrame('jump', 330, true).matrix[5], -20);
  close(motionFrame('jump', 660, true).matrix[5], 0);
  close(motionFrame('jump', 1430, true).matrix[5], -20);
  close(motionFrame('blink', 3840, true).matrix[3], 0.1);
  close(motionFrame('shadow', 1200, true).matrix[0], 0.82);
  close(motionFrame('breathe', 1700, true).matrix[0], 1.03);
  close(motionFrame('breathe', 1700, true).matrix[3], 0.96);
  assert.equal(motionFrame('pop', -250, true).opacity, 0);
  close(motionFrame('pop', 440, true, 1100).opacity, 1);
});

test('static and reduced-motion scenes keep effects visible and all transforms at rest', () => {
  for (const motion of ['bob', 'jump', 'nod', 'blink', 'wave', 'point', 'cheer-left', 'cheer-right', 'shadow', 'pop', 'tilt', 'startle', 'droop', 'breathe', 'twinkle']) {
    const frame = motionFrame(motion, 3840, false);
    assert.deepEqual(Array.from(frame.matrix), [1, 0, -0, 1, 0, 0]); assert.equal(frame.opacity, 1);
  }
});
