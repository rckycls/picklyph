import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { Icon, type IconName } from './Icon';

type PillTone = 'soft' | 'accent' | 'primary';
const tones = {
  soft: { backgroundColor: colors.selectedBackground, color: colors.selectedText },
  accent: { backgroundColor: colors.accent, color: colors.onAccent },
  primary: { backgroundColor: colors.primary, color: colors.onPrimary },
} satisfies Record<PillTone, { backgroundColor: string; color: string }>;

/** A compact icon + label action for toolbars above calendars and lists. */
export function IconPill({ icon, label, onPress, tone = 'soft', disabled = false, loading = false, accessibilityLabel }: {
  icon: IconName; label: string; onPress: () => void; tone?: PillTone; disabled?: boolean; loading?: boolean; accessibilityLabel?: string;
}) {
  const [focused, setFocused] = useState(false);
  const appearance = tones[tone]; const blocked = disabled || loading;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ disabled: blocked, busy: loading }}
      disabled={blocked} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} hitSlop={4}
      style={({ pressed }) => [styles.pill, { backgroundColor: appearance.backgroundColor }, focused && styles.focused, pressed && styles.pressed, blocked && styles.disabled]}>
      {loading ? <ActivityIndicator color={appearance.color} accessible={false} /> : <Icon name={icon} color={appearance.color} size={18} />}
      <Text style={[styles.label, { color: appearance.color }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** A round icon-only button; `accessibilityLabel` names the action. `danger` marks removals. */
export function IconButton({ icon, accessibilityLabel, onPress, disabled = false, loading = false, tone = 'soft' }: {
  icon: IconName; accessibilityLabel: string; onPress: () => void; disabled?: boolean; loading?: boolean; tone?: 'soft' | 'danger';
}) {
  const [focused, setFocused] = useState(false);
  const blocked = disabled || loading;
  const color = tone === 'danger' ? colors.error : colors.selectedText;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled: blocked, busy: loading }} disabled={blocked}
      onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} hitSlop={4}
      style={({ pressed }) => [styles.round, tone === 'danger' && styles.danger, focused && styles.focused, pressed && styles.pressed, disabled && styles.faded]}>
      {loading ? <ActivityIndicator color={color} accessible={false} /> : <Icon name={icon} color={color} size={20} />}
    </Pressable>
  );
}

/** A right-aligned, icon-only refresh for list views. While a server wait runs it stays disabled. */
export function RefreshButton({ accessibilityLabel, busy, waiting, onPress }: {
  accessibilityLabel: string; busy: boolean; waiting: boolean; onPress: () => void;
}) {
  // A stable label while waiting, so VoiceOver doesn't re-announce a countdown.
  return (
    <View style={styles.end}>
      <IconButton icon="refresh" accessibilityLabel={waiting ? `${accessibilityLabel}, available shortly` : accessibilityLabel}
        loading={busy} disabled={waiting} onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  end: { alignItems: 'flex-end' },
  pill: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 2, borderColor: 'transparent', flexShrink: 1 },
  label: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 20, flexShrink: 1 },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.selectedBackground,
    borderWidth: 2, borderColor: 'transparent' },
  danger: { backgroundColor: colors.errorBackground },
  focused: { borderColor: colors.text },
  pressed: { transform: [{ scale: 0.96 }] },
  disabled: { opacity: 0.55 },
  faded: { opacity: 0.35 },
});
