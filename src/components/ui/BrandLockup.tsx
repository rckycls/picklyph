import { Image, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

export function BrandLockup({ inverse = false, tagline = false }: { inverse?: boolean; tagline?: boolean }) {
  return (
    <View style={styles.container} accessible accessibilityRole="header" accessibilityLabel={tagline ? 'Pickly. Find a court. Run a court.' : 'Pickly'}>
      <View style={styles.lockup}>
        <Image source={inverse ? require('../../../assets/brand/mark-white.png') : require('../../../assets/brand/mark.png')}
          style={styles.mark} resizeMode="contain" accessible={false} />
        <Text style={[styles.wordmark, inverse && styles.inverse]}>pickly</Text>
      </View>
      {tagline && <Text style={[styles.tagline, inverse && styles.inverse]}>Find a court. Run a court.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { maxWidth: '100%', flexShrink: 1 },
  lockup: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  mark: { width: 28, height: 42 },
  wordmark: { fontFamily: fonts.extrabold, color: colors.primary, fontSize: 36, lineHeight: 44, letterSpacing: -1.5, flexShrink: 1 },
  tagline: { fontFamily: fonts.medium, color: colors.brandGreen, fontSize: 14, lineHeight: 21, marginTop: 4 },
  inverse: { color: colors.surface },
});
