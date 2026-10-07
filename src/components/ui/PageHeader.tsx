import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';
import { BRAND_TAGLINE, BrandLockup } from './BrandLockup';
import { StatusBadge } from './StatusBadge';

/** One region label and badge treatment for every top-level page. */
export function PageHeader({ title }: { title?: string }) {
  return <View style={styles.header}>
    <View style={styles.row}>
      {title ? <Text accessibilityRole="header" style={styles.title}>{title}</Text> : <BrandLockup />}
      <View style={styles.region}><StatusBadge label="Philippines" tone="neutral" /></View>
    </View>
    {!title && <Text style={styles.tagline}>{BRAND_TAGLINE}</Text>}
  </View>;
}

/** Shared safe-area-relative origin and gutters; each page owns its body spacing. */
export const pageLayout = StyleSheet.create({
  content: { width: '100%', maxWidth: 560, paddingHorizontal: 20, paddingTop: 12 },
});

const styles = StyleSheet.create({
  header: { gap: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 34, lineHeight: 44, letterSpacing: -1.2, flexShrink: 1 },
  region: { maxWidth: '100%' },
  tagline: { fontFamily: fonts.medium, color: colors.brandGreen, fontSize: 14, lineHeight: 21 },
});
