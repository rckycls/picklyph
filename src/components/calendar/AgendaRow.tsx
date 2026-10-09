import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { TIMELINE_TONES, type TimelineTone } from './DayTimeline';

type BadgeTone = 'neutral' | 'success' | 'pending' | 'error';

/**
 * One agenda entry: times on a rail at the left, a tone bar, then the details. Rows with
 * `onPress` open something (chevron); rows with `children` carry their own actions instead.
 */
export function AgendaRow({ start, end, tone, title, subtitle, badge, onPress, accessibilityLabel, children }: {
  start: string; end?: string; tone: TimelineTone; title: string; subtitle?: string;
  badge?: { label: string; tone: BadgeTone }; onPress?: () => void; accessibilityLabel?: string; children?: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const bar = TIMELINE_TONES[tone];
  const label = accessibilityLabel ?? [badge?.label, title, subtitle, `${start}${end ? ` to ${end}` : ''}`].filter(Boolean).join(', ');
  const body = (
    <>
      <View style={styles.times}>
        <Text style={styles.start} maxFontSizeMultiplier={1.4}>{start}</Text>
        {end && <Text style={styles.end} maxFontSizeMultiplier={1.4}>{end}</Text>}
      </View>
      <View style={[styles.bar, { backgroundColor: tone === 'block' || tone === 'muted' ? bar.borderColor : bar.backgroundColor }]} />
      <View style={styles.content}>
        {badge && <StatusBadge label={badge.label} tone={badge.tone} />}
        <Text style={styles.title}>{title}</Text>
        {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
      {onPress && <Icon name="chevronRight" color={colors.textSecondary} size={18} />}
    </>
  );
  if (onPress) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.card, styles.row, pressed && styles.pressed, focused && styles.focused]}>
        {body}
      </Pressable>
    );
  }
  return (
    <View style={styles.card}>
      <View style={styles.row} accessible accessibilityLabel={label}>{body}</View>
      {children && <View style={styles.actions}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 14, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  times: { width: 66, gap: 2 },
  start: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 15, lineHeight: 20 },
  end: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  bar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  content: { flex: 1, gap: 4 },
  title: { fontFamily: fonts.semibold, color: colors.text, fontSize: 16, lineHeight: 22 },
  subtitle: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pressed: { backgroundColor: colors.background },
  focused: { borderColor: colors.text, borderWidth: 2 },
});
