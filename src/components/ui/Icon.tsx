import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type IconName =
  | 'calendar' | 'desk' | 'inbox' | 'players' | 'clock' | 'edit' | 'pin' | 'court' | 'photo' | 'plus'
  | 'chevronLeft' | 'chevronRight' | 'chevronDown' | 'chevronUp' | 'close' | 'refresh' | 'check' | 'cash' | 'lock' | 'today';

/** Rounded 24-unit line icons. Decorative: pair each with visible text or an accessible label on its control. */
export function Icon({ name, color, size = 22, strokeWidth = 2 }: { name: IconName; color: string; size?: number; strokeWidth?: number }) {
  const line = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {name === 'calendar' && <>
        <Rect x={3.5} y={5} width={17} height={15.5} rx={3} {...line} />
        <Path d="M3.5 10h17M8 3v4M16 3v4" {...line} />
        <Rect x={7} y={13} width={3.5} height={3.5} rx={1} fill={color} />
      </>}
      {name === 'desk' && <>
        <Rect x={5} y={4.5} width={14} height={16.5} rx={2.5} {...line} />
        <Path d="M9 4.5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M9 13l2.2 2.2L15.5 11" {...line} />
      </>}
      {name === 'inbox' && <>
        <Path d="M4 13.5 6.4 6.2A1.8 1.8 0 0 1 8.1 5h7.8a1.8 1.8 0 0 1 1.7 1.2L20 13.5" {...line} />
        <Path d="M4 13.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4.5h-4.5a3.5 3.5 0 0 1-7 0H4Z" {...line} />
      </>}
      {name === 'players' && <>
        <Circle cx={9} cy={8} r={3.2} {...line} />
        <Path d="M3 19.5a6 6 0 0 1 12 0M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14a5 5 0 0 1 3.5 5" {...line} />
      </>}
      {name === 'clock' && <>
        <Circle cx={12} cy={12} r={8.5} {...line} />
        <Path d="M12 7.5V12l3 2" {...line} />
      </>}
      {name === 'edit' && <Path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10v4ZM13.5 6.5l4 4" {...line} />}
      {name === 'pin' && <>
        <Path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11Z" {...line} />
        <Circle cx={12} cy={10} r={2.3} {...line} />
      </>}
      {name === 'court' && <>
        <Rect x={3} y={6} width={18} height={12} rx={2} {...line} />
        <Path d="M12 6v12M7.5 6v12M16.5 6v12" {...line} />
      </>}
      {name === 'photo' && <>
        <Rect x={3} y={5} width={18} height={14} rx={2.5} {...line} />
        <Circle cx={8.5} cy={10} r={1.6} {...line} />
        <Path d="m21 15.5-4.5-4.5-8.5 8" {...line} />
      </>}
      {name === 'plus' && <Path d="M12 5v14M5 12h14" {...line} />}
      {name === 'chevronLeft' && <Path d="m14.5 5.5-6.5 6.5 6.5 6.5" {...line} />}
      {name === 'chevronRight' && <Path d="m9.5 5.5 6.5 6.5-6.5 6.5" {...line} />}
      {name === 'chevronDown' && <Path d="m5.5 9.5 6.5 6.5 6.5-6.5" {...line} />}
      {name === 'chevronUp' && <Path d="m5.5 14.5 6.5-6.5 6.5 6.5" {...line} />}
      {name === 'close' && <Path d="M6.5 6.5l11 11M17.5 6.5l-11 11" {...line} />}
      {name === 'refresh' && <Path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4.2h-4.2" {...line} />}
      {name === 'check' && <Path d="m5 12.5 4.5 4.5L19 7.5" {...line} />}
      {name === 'cash' && <>
        <Rect x={2.5} y={6} width={19} height={12} rx={2.5} {...line} />
        <Circle cx={12} cy={12} r={2.6} {...line} />
      </>}
      {name === 'lock' && <>
        <Rect x={5} y={10.5} width={14} height={10} rx={2.5} {...line} />
        <Path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" {...line} />
      </>}
      {name === 'today' && <>
        <Circle cx={12} cy={12} r={8.5} {...line} />
        <Circle cx={12} cy={12} r={3} fill={color} />
      </>}
    </Svg>
  );
}
