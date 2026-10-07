import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useOwnerMode } from '@/features/owner/OwnerMode';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

type Mode = 'player' | 'owner';
const options: readonly { mode: Mode; label: string; caption: string }[] = [
  { mode: 'player', label: 'Player', caption: 'Discover courts and follow your bookings.' },
  { mode: 'owner', label: 'Owner', caption: 'Manage your verified venues from the Venues tab.' },
];

/** Owners pick which side of pickly they're on. Switching is held while access is re-checked. */
export function ModeSwitch() {
  const { count, mode, setMode } = useOwnerMode();
  const checking = count === null;
  return (
    <View style={styles.container}>
      <View style={styles.track} accessibilityRole="radiogroup" accessibilityLabel="Use pickly as">
        {options.map((option) => (
          <Segment key={option.mode} label={option.label} selected={mode === option.mode} disabled={checking}
            onPress={() => setMode(option.mode)} />
        ))}
      </View>
      <Text style={styles.caption} accessibilityLiveRegion="polite">
        {checking ? 'Checking your venue access…' : options.find((option) => option.mode === mode)?.caption}
      </Text>
    </View>
  );
}

function Segment({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable accessibilityRole="radio" accessibilityLabel={`${label} mode`} accessibilityState={{ checked: selected, disabled }}
      disabled={disabled} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.segment, selected && styles.selected, focused && styles.focused, pressed && styles.pressed]}>
      <Text style={[styles.label, selected && styles.selectedLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  track: { flexDirection: 'row', backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  selected: { backgroundColor: colors.accent },
  focused: { borderColor: colors.text },
  pressed: { opacity: 0.85 },
  label: { fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
  selectedLabel: { color: colors.onAccent },
  caption: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginLeft: 6 },
});
