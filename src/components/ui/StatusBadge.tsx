import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';

type StatusTone = 'neutral' | 'success' | 'pending' | 'error';

const tones = {
  neutral: { backgroundColor: colors.selectedBackground, color: colors.selectedText },
  success: { backgroundColor: colors.successBackground, color: colors.success },
  pending: { backgroundColor: colors.pendingBackground, color: colors.pending },
  error: { backgroundColor: colors.errorBackground, color: colors.error },
} satisfies Record<StatusTone, { backgroundColor: string; color: string }>;

/** Always supply a human-readable label; tone alone never conveys a status. */
export function StatusBadge({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  const appearance = tones[tone];

  return (
    <View style={[styles.badge, { backgroundColor: appearance.backgroundColor }]}>
      <Text style={[styles.label, { color: appearance.color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignSelf: 'flex-start', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  label: { fontSize: 12, lineHeight: 18, fontWeight: '700' },
});
