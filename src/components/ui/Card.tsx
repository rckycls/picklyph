import { StyleSheet, View, type ViewProps } from 'react-native';

import { colors } from '@/theme/colors';

export type CardProps = ViewProps & { tone?: 'surface' | 'highlight' };

/** A non-interactive container; use a labeled Button for card actions. */
export function Card({ tone = 'surface', style, ...props }: CardProps) {
  return <View {...props} style={[styles.card, tone === 'highlight' && styles.highlight, style]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 24,
    padding: 22,
    gap: 16,
  },
  highlight: { backgroundColor: colors.selectedBackground },
});
