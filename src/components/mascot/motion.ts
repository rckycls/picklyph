export const MASCOT_POSES = ['idle', 'wave', 'tip', 'cheer', 'wink', 'thinking', 'surprised', 'oops', 'sleepy', 'star-struck'] as const;
export type MascotPose = typeof MASCOT_POSES[number];
export type MascotPlayback = 'loop' | 'once' | 'static';
export type Motion = 'bob' | 'jump' | 'nod' | 'blink' | 'wave' | 'point' | 'cheer-left' | 'cheer-right' | 'shadow' | 'pop' | 'tilt' | 'startle' | 'droop' | 'breathe' | 'twinkle';

// Durations and geometry come from the supplied Pickly SVG/CSS artboards.
export const onceDuration: Record<MascotPose, number> = {
  idle: 2400, wave: 2400, tip: 1600, cheer: 3300, wink: 2400,
  thinking: 3000, surprised: 2000, oops: 3200, sleepy: 3400, 'star-struck': 2400,
};
export const bodyMotion: Record<MascotPose, Motion> = {
  idle: 'bob', wave: 'bob', tip: 'nod', cheer: 'jump', wink: 'bob',
  thinking: 'tilt', surprised: 'startle', oops: 'droop', sleepy: 'breathe', 'star-struck': 'bob',
};

function phase(ms: number, duration: number) {
  'worklet';
  return (Math.max(0, ms) % duration) / duration;
}

// CSS ease-in-out cubic-bezier(.42, 0, .58, 1), solved in time coordinates.
function ease(t: number, out = false) {
  'worklet';
  if (t <= 0 || t >= 1) return t;
  let low = 0; let high = 1; let s = t;
  for (let i = 0; i < 10; i++) {
    const x = 3 * (1 - s) ** 2 * s * (out ? 0 : 0.42) + 3 * (1 - s) * s ** 2 * 0.58 + s ** 3;
    if (x < t) low = s; else high = s;
    s = (low + high) / 2;
  }
  return 3 * (1 - s) * s ** 2 + s ** 3;
}

function keyframes(p: number, times: number[], values: number[], linear = false, easeOut = false) {
  'worklet';
  for (let i = 1; i < times.length; i++) {
    const end = times[i]!;
    if (p <= end) {
      const start = times[i - 1]!;
      const t = (p - start) / (end - start);
      return values[i - 1]! + (values[i]! - values[i - 1]!) * (linear ? t : ease(t, easeOut));
    }
  }
  return values[values.length - 1]!;
}

/** Numeric SVG matrix avoids CSS transform/origin differences on native SVG groups. */
export function motionFrame(kind: Motion, ms: number, animated: boolean, popDuration = 1600) {
  'worklet';
  let x = 0; let y = 0; let rotation = 0; let sx = 1; let sy = 1; let opacity = 1;
  if (animated) {
    const oscillate = (duration: number, start: number, middle: number) => {
      'worklet';
      return keyframes(phase(ms, duration), [0, 0.5, 1], [start, middle, start]);
    };
    switch (kind) {
      case 'bob': y = oscillate(2400, 0, -6); break;
      case 'jump': y = keyframes(phase(ms, 1100), [0, 0.3, 0.6, 1], [0, -20, 0, 0]); break;
      case 'nod': { const n = oscillate(1600, 0, 1); x = 4 * n; y = -3 * n; break; }
      case 'blink': sy = keyframes(phase(ms, 4000), [0, 0.92, 0.96, 1], [1, 1, 0.1, 1], true); break;
      case 'wave': rotation = oscillate(700, -14, 18); break;
      case 'point': x = oscillate(800, 0, 4); break;
      case 'cheer-left': rotation = oscillate(550, -10, 12); break;
      case 'cheer-right': rotation = oscillate(550, 10, -12); break;
      case 'shadow': sx = oscillate(2400, 1, 0.82); break;
      case 'pop': {
        if (ms < 0) { sx = sy = 0.4; opacity = 0; break; }
        const p = phase(ms, popDuration);
        sx = sy = keyframes(p, [0, 0.4, 0.7, 1], [0.4, 1, 1, 0.4]);
        opacity = keyframes(p, [0, 0.4, 0.7, 1], [0, 1, 1, 0]);
        break;
      }
      case 'tilt': rotation = oscillate(3000, -4, 5); break;
      case 'startle': {
        const p = phase(ms, 2000);
        y = keyframes(p, [0, 0.12, 0.24, 0.55, 1], [0, -16, 0, 0, 0], false, true);
        sx = sy = keyframes(p, [0, 0.12, 0.24, 0.55, 1], [1, 1.06, 0.98, 1, 1], false, true);
        break;
      }
      case 'droop': rotation = oscillate(3200, -3, -6); y = oscillate(3200, 0, 4); break;
      case 'breathe': sx = oscillate(3400, 1, 1.03); sy = oscillate(3400, 1, 0.96); break;
      case 'twinkle': sx = sy = oscillate(1000, 1, 0.7); rotation = oscillate(1000, 0, 45); break;
    }
  }
  const angle = rotation * Math.PI / 180;
  return { matrix: [Math.cos(angle) * sx, Math.sin(angle) * sx, -Math.sin(angle) * sy, Math.cos(angle) * sy, x, y], opacity };
}
