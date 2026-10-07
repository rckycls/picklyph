import type { ReactNode } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle, Ellipse, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { palette } from '@/theme/colors';
import { fonts } from '@/theme/typography';
import { bodyMotion, motionFrame, type MascotPlayback, type MascotPose, type Motion } from './motion';
import { useMascotClock } from './useMascotClock';

export type { MascotPlayback, MascotPose } from './motion';
export type PicklyMascotProps = { pose?: MascotPose; size?: number; playback?: MascotPlayback };
const AnimatedG = Animated.createAnimatedComponent(G);
const blue = palette.courtBlue;
const lime = palette.ballLime;
const star = 'M0 -8 Q1.4 -1.4 8 0 Q1.4 1.4 0 8 Q-1.4 1.4 -8 0 Q-1.4 -1.4 0 -8 Z';
type Clock = { elapsed: SharedValue<number>; animated: boolean };

function MotionGroup({ clock, kind, delay = 0, popDuration = 1600, children }: {
  clock: Clock; kind: Motion; delay?: number; popDuration?: number; children: ReactNode;
}) {
  const { elapsed, animated } = clock;
  const props = useAnimatedProps(() => motionFrame(kind, elapsed.value - delay, animated, popDuration));
  return <AnimatedG animatedProps={props}>{children}</AnimatedG>;
}

function Eye({ x, y = 50, rx = 3.8, ry = 5.4, clock, blink = true }: {
  x: number; y?: number; rx?: number; ry?: number; clock: Clock; blink?: boolean;
}) {
  const eye = <Ellipse cx={0} cy={0} rx={rx} ry={ry} fill={blue} />;
  return <G transform={`translate(${x} ${y})`}>{blink ? <MotionGroup clock={clock} kind="blink">{eye}</MotionGroup> : eye}</G>;
}

function Face({ pose, clock }: { pose: MascotPose; clock: Clock }) {
  if (pose === 'surprised') return <>
    <Circle cx={48} cy={49} r={6.2} fill={blue} /><Circle cx={50} cy={47} r={2} fill={palette.white} />
    <Circle cx={72} cy={49} r={6.2} fill={blue} /><Circle cx={74} cy={47} r={2} fill={palette.white} />
    <Ellipse cx={60} cy={67} rx={4.2} ry={5.2} fill={blue} />
  </>;
  if (pose === 'sleepy') return <>
    <Path d="M44 50 Q49 55 54 50 M66 50 Q71 55 76 50" fill="none" stroke={blue} strokeWidth={3} strokeLinecap="round" />
    <Circle cx={60} cy={65} r={2.6} fill={blue} />
  </>;
  if (pose === 'star-struck') return <>
    {[48, 72].map((x) => <G key={x} transform={`translate(${x} 49)`}><MotionGroup clock={clock} kind="twinkle"><Path d={star} fill={blue} /></MotionGroup></G>)}
    <Path d="M50 60 H70 Q70 72 60 72 Q50 72 50 60 Z" fill={blue} />
  </>;
  if (pose === 'cheer') return <>
    <Path d="M44 52 Q49 44 54 52 M66 52 Q71 44 76 52" fill="none" stroke={blue} strokeWidth={3} strokeLinecap="round" />
    <Path d="M50 60 H70 Q70 72 60 72 Q50 72 50 60 Z" fill={blue} />
  </>;
  if (pose === 'thinking') return <>
    <Eye x={52} y={46} rx={3.6} ry={4.6} clock={clock} blink={false} /><Eye x={74} y={46} rx={3.6} ry={4.6} clock={clock} blink={false} />
    <Path d="M55 66 H66" fill="none" stroke={blue} strokeWidth={3} strokeLinecap="round" />
  </>;
  const sorry = pose === 'oops';
  return <>
    <Eye x={49} y={sorry ? 51 : 50} rx={sorry ? 3.6 : 3.8} ry={sorry ? 4.8 : 5.4} clock={clock} />
    {pose === 'wink' ? <Path d="M66 51 Q71 45 76 51" fill="none" stroke={blue} strokeWidth={3} strokeLinecap="round" />
      : <Eye x={71} y={sorry ? 51 : 50} rx={sorry ? 3.6 : 3.8} ry={sorry ? 4.8 : 5.4} clock={clock} />}
    {sorry && <Path d="M43 44 L53 40 M67 40 L77 44" fill="none" stroke={blue} strokeWidth={3} strokeLinecap="round" />}
    {pose === 'wink' ? <Path d="M50 60 H70 Q70 72 60 72 Q50 72 50 60 Z" fill={blue} />
      : <Path d={sorry ? 'M51 68 Q60 60 69 68' : 'M50 62 Q60 71 70 62'} fill="none" stroke={blue} strokeWidth={3} strokeLinecap="round" />}
  </>;
}

function Arms({ pose, clock }: { pose: MascotPose; clock: Clock }) {
  const raised = pose === 'cheer' || pose === 'star-struck';
  const left = raised ? [-20, -24] : pose === 'surprised' ? [-22, -8] : pose === 'oops' ? [-9, 20] : [-16, 16];
  const right = raised ? [20, -24] : pose === 'wave' ? [22, -22] : pose === 'tip' ? [30, -8]
    : pose === 'wink' ? [22, -16] : pose === 'surprised' ? [22, -8] : pose === 'oops' ? [9, 20] : [16, 16];
  const arm = (end: number[]) => <Line x1={0} y1={0} x2={end[0]} y2={end[1]} stroke={blue} strokeWidth={8} strokeLinecap="round" />;
  return <>
    <G transform="translate(34 98)">{raised ? <MotionGroup clock={clock} kind="cheer-left">{arm(left)}</MotionGroup> : arm(left)}</G>
    {pose !== 'thinking' && <G transform="translate(86 98)">
      {raised ? <MotionGroup clock={clock} kind="cheer-right">{arm(right)}</MotionGroup>
        : pose === 'wave' || pose === 'tip' ? <MotionGroup clock={clock} kind={pose === 'wave' ? 'wave' : 'point'}>{arm(right)}</MotionGroup> : arm(right)}
    </G>}
  </>;
}

function Effects({ pose, clock }: { pose: MascotPose; clock: Clock }) {
  const pop = (x: number, y: number, child: ReactNode, delay = 0) => <G key={`${x}:${y}`} transform={`translate(${x} ${y})`}>
    <MotionGroup clock={clock} kind="pop" delay={delay} popDuration={pose === 'cheer' ? 1100 : 1600}>{child}</MotionGroup>
  </G>;
  if (pose === 'thinking') return <>{pop(146, 50, <Circle r={3.5} fill={blue} />)}{pop(157, 36, <Circle r={5} fill={blue} />, 300)}{pop(169, 18, <Circle r={7} fill={blue} />, 600)}</>;
  if (pose === 'sleepy') return <>{[[136, 52, 15], [148, 36, 19], [162, 18, 24]].map(([x, y, size], i) =>
    pop(x!, y!, <SvgText fontFamily={fonts.extrabold} fontSize={size} fill={blue}>z</SvgText>, i * 300))}</>;
  if (pose === 'oops') return pop(150, 52, <Path d="M0 -9 Q7 2 0 6 Q-7 2 0 -9 Z" fill={palette.white} stroke={blue} strokeWidth={2} />);
  if (pose === 'surprised') return <>
    {pop(22, 36, <Line x1={0} y1={0} x2={-10} y2={-8} stroke={blue} strokeWidth={3} strokeLinecap="round" />)}
    {pop(158, 36, <Line x1={0} y1={0} x2={10} y2={-8} stroke={blue} strokeWidth={3} strokeLinecap="round" />)}
    {pop(90, 8, <Line x1={0} y1={0} x2={0} y2={-7} stroke={blue} strokeWidth={3} strokeLinecap="round" />)}
  </>;
  if (pose === 'wink') return pop(160, 40, <Path d={star} fill={lime} stroke={blue} strokeWidth={2} />);
  if (pose === 'cheer') return <>
    {pop(8, 14, <Circle r={5} fill={palette.courtGreen} />)}
    {pop(172, 24, <Circle r={6} fill={lime} stroke={blue} strokeWidth={2} />, 250)}
    {pop(160, 70, <Circle r={4} fill={palette.courtGreen} />, 500)}
  </>;
  if (pose === 'star-struck') return <>
    {pop(16, 30, <Path d={star} fill={lime} stroke={blue} strokeWidth={2} />)}
    {pop(166, 26, <Path d={star} fill={lime} stroke={blue} strokeWidth={2} />, 300)}
    {pop(160, 76, <Circle r={4} fill={palette.courtGreen} />, 600)}
  </>;
  return null;
}

/** size is the SVG's height; its 180:200 aspect ratio remains constant. */
export function PicklyMascot({ pose = 'idle', size = 160, playback = 'loop' }: PicklyMascotProps) {
  return <MascotAnimation key={`${pose}:${playback}`} pose={pose} size={size} playback={playback} />;
}

function MascotAnimation({ pose, size, playback }: Required<PicklyMascotProps>) {
  const clock = useMascotClock(pose, playback);
  const displayedPose = pose === 'cheer' && clock.finished ? 'idle' : pose;
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Svg width={size * 0.9} height={size} viewBox="0 0 180 200" accessible={false}>
      <G transform="translate(90 190)"><MotionGroup clock={clock} kind="shadow"><Ellipse cx={0} cy={0} rx={26} ry={5} fill={blue} opacity={0.16} /></MotionGroup></G>
      <Effects pose={displayedPose} clock={clock} />
      <G transform="translate(90 180)"><MotionGroup clock={clock} kind={bodyMotion[displayedPose]}><G transform="translate(-60 -150)">
        <Arms pose={displayedPose} clock={clock} />
        <Path d="M60 150 L53 140 V129 C53 110 12 94 12 54 A48 48 0 1 1 108 54 C108 94 67 110 67 129 V140 Z" fill={blue} />
        <Circle cx={60} cy={54} r={30} fill={lime} />
        <Face pose={displayedPose} clock={clock} />
        {displayedPose === 'thinking' && <Line x1={89} y1={106} x2={74} y2={83} stroke={blue} strokeWidth={8} strokeLinecap="round" />}
        <Line x1={53} y1={131.5} x2={67} y2={131.5} stroke={lime} strokeWidth={2.4} />
        <Line x1={53} y1={137.5} x2={67} y2={137.5} stroke={lime} strokeWidth={2.4} />
      </G></MotionGroup></G>
    </Svg>
  </View>;
}
