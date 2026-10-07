import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

/**
 * Steps through a fixed list of allowed values (times, dates), so an invalid value
 * can't be entered. Small buttons move one option; large ones move `jump` options.
 * VoiceOver users swipe up/down on the value (adjustable role).
 */
export function OptionStepper<T>({ label, options, value, format, onChange, disabled = false, jump = 6, jumpLabel = '3 hours' }: {
  label: string; options: readonly T[]; value: T; format: (value: T) => string; onChange: (value: T) => void;
  disabled?: boolean; jump?: number; jumpLabel?: string;
}) {
  const index = options.indexOf(value);
  const move = (by: number) => {
    if (disabled || index < 0) return;
    const next = Math.min(options.length - 1, Math.max(0, index + by));
    if (next !== index) onChange(options[next]!);
  };
  const atStart = disabled || index <= 0; const atEnd = disabled || index < 0 || index >= options.length - 1;
  return (
    <View style={styles.stepper}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        {options.length > jump && <Step text="«" label={`${label}: ${jumpLabel} earlier`} disabled={atStart} onPress={() => move(-jump)} />}
        <Step text="−" label={`${label}: earlier`} disabled={atStart} onPress={() => move(-1)} />
        <View accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text: index < 0 ? 'Not set' : format(value) }}
          accessibilityState={{ disabled }} accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => move(event.nativeEvent.actionName === 'increment' ? 1 : -1)} style={styles.value}>
          <Text style={[styles.valueText, disabled && styles.disabledText]}>{index < 0 ? 'Not set' : format(value)}</Text>
        </View>
        <Step text="+" label={`${label}: later`} disabled={atEnd} onPress={() => move(1)} />
        {options.length > jump && <Step text="»" label={`${label}: ${jumpLabel} later`} disabled={atEnd} onPress={() => move(jump)} />}
      </View>
    </View>
  );
}

function Step({ text, label, disabled, onPress }: { text: string; label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      hitSlop={4} style={({ pressed }) => [styles.step, pressed && styles.pressed, disabled && styles.disabled]}>
      <Text style={styles.stepText}>{text}</Text>
    </Pressable>
  );
}

export function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
      style={[styles.choice, selected && styles.selected, disabled && styles.disabled]}>
      <Text style={[styles.choiceLabel, selected && styles.selectedLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stepper: { gap: 6, flexGrow: 1 },
  label: { fontFamily: fonts.semibold, color: colors.text, fontSize: 14, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: { flex: 1, minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8,
    borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface },
  valueText: { fontFamily: fonts.semibold, color: colors.text, fontSize: 15, textAlign: 'center' },
  disabledText: { color: colors.textSecondary },
  step: { minWidth: 44, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.selectedBackground },
  stepText: { fontFamily: fonts.semibold, color: colors.selectedText, fontSize: 20 },
  pressed: { opacity: 0.7 }, disabled: { opacity: 0.4 },
  choice: { minHeight: 44, padding: 12, borderWidth: 2, borderColor: colors.border, borderRadius: 12 },
  selected: { backgroundColor: colors.selectedBackground, borderColor: colors.primary },
  choiceLabel: { fontFamily: fonts.semibold, fontSize: 15, color: colors.textSecondary }, selectedLabel: { color: colors.selectedText },
});
