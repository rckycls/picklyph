import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme/colors';

/** Decorative brand illustration, deliberately hidden from screen readers. */
export function CourtArtwork() {
  return (
    <View style={styles.artwork} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={styles.court}>
        <View style={styles.net} />
        <View style={styles.kitchenTop} />
        <View style={styles.kitchenBottom} />
        <View style={styles.centerTop} />
        <View style={styles.centerBottom} />
      </View>
      <View style={styles.ball}>
        <View style={[styles.hole, styles.firstHole]} />
        <View style={[styles.hole, styles.secondHole]} />
        <View style={[styles.hole, styles.thirdHole]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  artwork: { backgroundColor: colors.primary, borderRadius: 24, height: 180, overflow: 'hidden', padding: 28 },
  court: { flex: 1, backgroundColor: colors.secondary, borderColor: colors.onPrimary, borderWidth: 2, marginHorizontal: 30, transform: [{ rotate: '-10deg' }] },
  net: { position: 'absolute', left: 0, right: 0, top: '50%', height: 4, backgroundColor: colors.text },
  kitchenTop: { position: 'absolute', left: 0, right: 0, top: '32%', height: 2, backgroundColor: colors.onPrimary },
  kitchenBottom: { position: 'absolute', left: 0, right: 0, top: '68%', height: 2, backgroundColor: colors.onPrimary },
  centerTop: { position: 'absolute', top: 0, left: '50%', width: 2, height: '32%', backgroundColor: colors.onPrimary },
  centerBottom: { position: 'absolute', bottom: 0, left: '50%', width: 2, height: '32%', backgroundColor: colors.onPrimary },
  ball: { position: 'absolute', width: 60, height: 60, borderRadius: 30, backgroundColor: colors.accent, bottom: 20, right: 24, transform: [{ rotate: '15deg' }] },
  hole: { position: 'absolute', width: 8, height: 11, borderRadius: 6, backgroundColor: colors.onAccent },
  firstHole: { top: 13, left: 16 },
  secondHole: { top: 19, right: 12 },
  thirdHole: { bottom: 11, left: 24 },
});
