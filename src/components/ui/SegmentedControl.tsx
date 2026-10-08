import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

/** Two or three mutually exclusive choices in a rounded track (radio group semantics). */
export function SegmentedControl<T extends string>({ options, value, onChange, disabled = false, accessibilityLabel }: {
  options: readonly { value: T; label: string; accessibilityLabel?: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  return (
    <View style={styles.track} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {options.map((option) => (
        <Segment key={option.value} label={option.label} accessibilityLabel={option.accessibilityLabel ?? option.label} selected={value === option.value} disabled={disabled}
          onPress={() => onChange(option.value)} />
      ))}
    </View>
  );
}

function Segment({ label, accessibilityLabel, selected, disabled, onPress }: { label: string; accessibilityLabel: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable accessibilityRole="radio" accessibilityLabel={accessibilityLabel} accessibilityState={{ checked: selected, disabled }}
      disabled={disabled} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.segment, selected && styles.selected, focused && styles.focused, pressed && styles.pressed]}>
      <Text style={[styles.label, selected && styles.selectedLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  selected: { backgroundColor: colors.accent },
  focused: { borderColor: colors.text },
  pressed: { opacity: 0.85 },
  label: { fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
  selectedLabel: { color: colors.onAccent },
});
