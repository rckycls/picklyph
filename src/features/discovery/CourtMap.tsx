import { StyleSheet, Text, View } from 'react-native';

import { screenText } from '@/components/ui/Screen';
import { colors } from '@/theme/colors';

import type { CourtMapProps } from './mapTypes';

/** Browser fallback. Metro selects CourtMap.native.tsx for an iPhone build. */
export default function CourtMap(_props: CourtMapProps) {
  return (
    <View style={styles.placeholder}>
      <Text accessibilityRole="header" style={screenText.title}>Explore on your iPhone.</Text>
      <Text style={screenText.body}>The Google court map is available in the PicklyPH iPhone development build.</Text>
      <Text style={screenText.body}>Choose List to browse approved venues across the Philippines.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: colors.selectedBackground },
});
