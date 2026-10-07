import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import { runOnJS, useFrameCallback, useReducedMotion, useSharedValue } from 'react-native-reanimated';

import { onceDuration, type MascotPlayback, type MascotPose } from './motion';

/** One UI-thread clock per mascot. Inactive screens/backgrounds do not advance it. */
export function useMascotClock(pose: MascotPose, playback: MascotPlayback) {
  const focused = useIsFocused();
  const systemReduced = useReducedMotion();
  const [reduced, setReduced] = useState(systemReduced);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [finished, setFinished] = useState(false);
  const elapsed = useSharedValue(0);
  const duration = onceDuration[pose];
  useEffect(() => {
    const app = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (alive) setReduced(value); }).catch(() => {});
    return () => { alive = false; app.remove(); motion.remove(); };
  }, []);
  // The rendering component keys this hook by pose/playback, giving each animation a fresh clock.
  const frame = useFrameCallback((info) => {
    if (playback === 'once' && elapsed.get() >= duration) return;
    const next = elapsed.get() + (info.timeSincePreviousFrame ?? 0);
    elapsed.set(playback === 'once' ? Math.min(next, duration) : next);
    if (playback === 'once' && next >= duration) runOnJS(setFinished)(true);
  }, false);
  const moving = focused && foreground && !reduced && playback !== 'static' && !finished;
  useEffect(() => { frame.setActive(moving); return () => frame.setActive(false); }, [frame, moving]);
  return { elapsed, animated: !reduced && playback !== 'static' && !finished, finished };
}
