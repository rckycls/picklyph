import { Children, Fragment, isValidElement, useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

export type GlyphName = 'venue' | 'plus' | 'flag' | 'mail' | 'lock' | 'leave' | 'retry' | 'user' | 'phone' | 'settings' | 'location' | 'bell' | 'eye' | 'eyeOff';
export type RowTone = 'blue' | 'green' | 'lime' | 'red';

const tones = {
  blue: { backgroundColor: colors.selectedBackground, color: colors.primary },
  green: { backgroundColor: colors.successBackground, color: colors.success },
  lime: { backgroundColor: colors.pendingBackground, color: colors.pending },
  red: { backgroundColor: colors.errorBackground, color: colors.error },
} satisfies Record<RowTone, { backgroundColor: string; color: string }>;

/** A titled, rounded list; rows get hairline separators like a settings screen. */
export function MenuGroup({ title, children }: { title?: string; children: ReactNode }) {
  const rows = Children.toArray(children).filter(isValidElement);
  if (!rows.length) return null;
  return (
    <View style={styles.group}>
      {title && <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text>}
      <View style={styles.list}>
        {rows.map((row, index) => (
          <Fragment key={row.key ?? index}>
            {index > 0 && <View style={styles.separator} />}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

type MenuRowProps = {
  icon: GlyphName;
  tone?: RowTone;
  title: string;
  overline?: string;
  subtitle?: string;
  onPress?: () => void;
  destructive?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  /** A separate control at the end of the row (outside the row's own accessibility element). */
  accessory?: ReactNode;
  children?: ReactNode;
};

/** Pressable rows show a chevron; rows without onPress are read-only details. */
export function MenuRow({ icon, tone = 'blue', title, overline, subtitle, onPress, destructive, loading, accessibilityLabel, accessory, children }: MenuRowProps) {
  const [focused, setFocused] = useState(false);
  const appearance = tones[destructive ? 'red' : tone];
  const label = accessibilityLabel ?? [overline, title, subtitle].filter(Boolean).join(', ');
  const body = (
    <>
      <View style={[styles.tile, { backgroundColor: appearance.backgroundColor }]}>
        <Glyph name={icon} color={appearance.color} />
      </View>
      <View style={styles.text}>
        {overline && <Text style={styles.overline}>{overline}</Text>}
        <Text style={[styles.title, destructive && { color: colors.error }]}>{title}</Text>
        {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        {children}
      </View>
      {loading ? <ActivityIndicator color={appearance.color} accessible={false} />
        : onPress && !destructive && <View style={styles.chevron} />}
    </>
  );

  const row = !onPress ? <View style={[styles.row, accessory !== undefined && styles.grow]} accessible accessibilityLabel={label}>{body}</View> : (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: loading, busy: loading }}
      disabled={loading} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.row, accessory !== undefined && styles.grow, (pressed || focused) && styles.pressed, focused && styles.focused]}>
      {body}
    </Pressable>
  );
  if (accessory === undefined) return row;
  return <View style={styles.withAccessory}>{row}<View style={styles.accessory}>{accessory}</View></View>;
}

/** Eye button that shows or hides a private value such as an email address. */
export function RevealButton({ shown, label, onToggle }: { shown: boolean; label: string; onToggle: () => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={shown ? `Hide ${label}` : `Show ${label}`} onPress={onToggle} hitSlop={8}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.reveal, (pressed || focused) && styles.pressed, focused && styles.focused]}>
      <Glyph name={shown ? 'eyeOff' : 'eye'} color={colors.textSecondary} />
    </Pressable>
  );
}

/** Small line icons drawn with native views, matching TabIcon. Decorative only. */
export function Glyph({ name, color }: { name: GlyphName; color: string }) {
  return (
    <View style={styles.glyph} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {name === 'venue' && <Image source={require('../../../assets/brand/mark-small.png')} style={[styles.pin, { tintColor: color }]} resizeMode="contain" />}
      {name === 'plus' && <>
        <View style={[styles.plusBar, { backgroundColor: color }]} />
        <View style={[styles.plusBar, styles.vertical, { backgroundColor: color }]} />
      </>}
      {name === 'flag' && <>
        <View style={[styles.pole, { backgroundColor: color }]} />
        <View style={[styles.banner, { backgroundColor: color }]} />
      </>}
      {name === 'mail' && (
        <View style={[styles.envelope, { borderColor: color }]}>
          <View style={[styles.flap, { borderColor: color }]} />
        </View>
      )}
      {name === 'lock' && <>
        <View style={[styles.shackle, { borderColor: color }]} />
        <View style={[styles.lockBody, { backgroundColor: color }]} />
      </>}
      {name === 'leave' && <>
        <View style={[styles.door, { borderColor: color }]} />
        <View style={[styles.arrowShaft, { backgroundColor: color }]} />
        <View style={[styles.arrowHead, { borderColor: color }]} />
      </>}
      {name === 'retry' && <>
        <View style={[styles.ring, { borderColor: color }]} />
        <View style={[styles.ringTip, { borderColor: color }]} />
      </>}
      {name === 'user' && <>
        <View style={[styles.head, { borderColor: color }]} />
        <View style={[styles.shoulders, { borderColor: color }]} />
      </>}
      {name === 'phone' && (
        <View style={[styles.handset, { borderColor: color }]}>
          <View style={[styles.speaker, { backgroundColor: color }]} />
        </View>
      )}
      {name === 'settings' && <>
        <View style={[styles.slider, styles.sliderTop, { backgroundColor: color }]} />
        <View style={[styles.knob, styles.knobTop, { borderColor: color }]} />
        <View style={[styles.slider, styles.sliderBottom, { backgroundColor: color }]} />
        <View style={[styles.knob, styles.knobBottom, { borderColor: color }]} />
      </>}
      {name === 'location' && <>
        <View style={[styles.target, { borderColor: color }]} />
        <View style={[styles.dot, { backgroundColor: color }]} />
      </>}
      {name === 'bell' && <>
        <View style={[styles.bellBody, { borderColor: color }]} />
        <View style={[styles.bellRim, { backgroundColor: color }]} />
        <View style={[styles.bellClapper, { backgroundColor: color }]} />
      </>}
      {(name === 'eye' || name === 'eyeOff') && <>
        <View style={[styles.eye, { borderColor: color }]} />
        <View style={[styles.pupil, { backgroundColor: color }]} />
        {name === 'eyeOff' && <View style={[styles.strike, { backgroundColor: color }]} />}
      </>}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 10 },
  groupTitle: { fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 12, lineHeight: 18, letterSpacing: 1.2, textTransform: 'uppercase', marginLeft: 6 },
  list: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 22, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 66 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 2, borderColor: 'transparent' },
  pressed: { backgroundColor: colors.background },
  focused: { borderColor: colors.text, borderRadius: 20 },
  tile: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 2 },
  overline: { fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  title: { fontFamily: fonts.semibold, color: colors.text, fontSize: 16, lineHeight: 22 },
  subtitle: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  chevron: { width: 9, height: 9, borderTopWidth: 2, borderRightWidth: 2, borderColor: colors.textSecondary, transform: [{ rotate: '45deg' }], marginRight: 4 },
  glyph: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  pin: { width: 13, height: 19 },
  plusBar: { position: 'absolute', width: 14, height: 2.5, borderRadius: 2 },
  vertical: { transform: [{ rotate: '90deg' }] },
  pole: { position: 'absolute', left: 4, top: 1, width: 2, height: 18, borderRadius: 1 },
  banner: { position: 'absolute', left: 6, top: 2, width: 10, height: 8, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  envelope: { width: 18, height: 14, borderWidth: 2, borderRadius: 3, alignItems: 'center', overflow: 'hidden' },
  flap: { width: 10, height: 10, borderRightWidth: 2, borderBottomWidth: 2, marginTop: -6, transform: [{ rotate: '45deg' }] },
  shackle: { position: 'absolute', top: 1, width: 10, height: 10, borderWidth: 2, borderBottomWidth: 0, borderTopLeftRadius: 5, borderTopRightRadius: 5 },
  lockBody: { position: 'absolute', bottom: 1, width: 15, height: 10, borderRadius: 3 },
  bellBody: { position: 'absolute', top: 2, width: 14, height: 13, borderWidth: 2, borderBottomWidth: 0, borderTopLeftRadius: 7, borderTopRightRadius: 7 },
  bellRim: { position: 'absolute', top: 14, width: 18, height: 2, borderRadius: 1 },
  bellClapper: { position: 'absolute', bottom: 1, width: 6, height: 3, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  door: { position: 'absolute', left: 1, width: 9, height: 16, borderWidth: 2, borderRightWidth: 0, borderTopLeftRadius: 3, borderBottomLeftRadius: 3 },
  arrowShaft: { position: 'absolute', left: 6, width: 11, height: 2, borderRadius: 1 },
  arrowHead: { position: 'absolute', right: 2, width: 7, height: 7, borderTopWidth: 2, borderRightWidth: 2, transform: [{ rotate: '45deg' }] },
  ring: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderTopColor: 'transparent' },
  ringTip: { position: 'absolute', top: 1, right: 3, width: 6, height: 6, borderTopWidth: 2, borderRightWidth: 2, transform: [{ rotate: '20deg' }] },
  grow: { flex: 1 },
  withAccessory: { flexDirection: 'row', alignItems: 'center' },
  accessory: { paddingRight: 12 },
  reveal: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  head: { position: 'absolute', top: 1, width: 9, height: 9, borderRadius: 5, borderWidth: 2 },
  shoulders: { position: 'absolute', bottom: 1, width: 16, height: 8, borderWidth: 2, borderBottomWidth: 0, borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  handset: { width: 12, height: 19, borderWidth: 2, borderRadius: 3, alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 2 },
  speaker: { width: 4, height: 2, borderRadius: 1 },
  slider: { position: 'absolute', left: 1, right: 1, height: 2, borderRadius: 1 },
  sliderTop: { top: 5 },
  sliderBottom: { bottom: 5 },
  knob: { position: 'absolute', width: 7, height: 7, borderRadius: 4, borderWidth: 2, backgroundColor: colors.surface },
  knobTop: { top: 2.5, left: 3 },
  knobBottom: { bottom: 2.5, right: 3 },
  target: { width: 16, height: 16, borderRadius: 8, borderWidth: 2 },
  dot: { position: 'absolute', width: 6, height: 6, borderRadius: 3 },
  eye: { width: 20, height: 12, borderRadius: 10, borderWidth: 2 },
  pupil: { position: 'absolute', width: 6, height: 6, borderRadius: 3 },
  strike: { position: 'absolute', width: 22, height: 2, borderRadius: 1, transform: [{ rotate: '-35deg' }] },
});
