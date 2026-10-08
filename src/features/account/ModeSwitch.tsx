import { StyleSheet, Text, View } from 'react-native';

import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useOwnerMode } from '@/features/owner/OwnerMode';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

type Mode = 'player' | 'owner';
const options: readonly { value: Mode; label: string; accessibilityLabel: string; caption: string }[] = [
  { value: 'player', label: 'Player', accessibilityLabel: 'Player mode', caption: 'Discover courts and follow your bookings.' },
  { value: 'owner', label: 'Owner', accessibilityLabel: 'Owner mode', caption: 'Add or claim your venue, and manage it from the Venues tab.' },
];

/** Every signed-in account picks which side of pickly it's on. Switching is held while access is re-checked. */
export function ModeSwitch() {
  const { count, mode, setMode } = useOwnerMode();
  const checking = count === null;
  return (
    <View style={styles.container}>
      <SegmentedControl options={options} value={mode} onChange={setMode} disabled={checking} accessibilityLabel="Use pickly as" />
      <Text style={styles.caption} accessibilityLiveRegion="polite">
        {checking ? 'Checking your venue access…' : options.find((option) => option.value === mode)?.caption}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 8 },
  caption: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19, marginLeft: 6 },
});
