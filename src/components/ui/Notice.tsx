import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { Icon } from './Icon';

const tones = {
  info: { backgroundColor: colors.selectedBackground, color: colors.selectedText },
  success: { backgroundColor: colors.successBackground, color: colors.success },
  error: { backgroundColor: colors.errorBackground, color: colors.error },
} as const;

/** A short status line after an action (announced politely to screen readers). */
export function Notice({ text, tone = 'info' }: { text: string; tone?: keyof typeof tones }) {
  const appearance = tones[tone];
  return (
    <View style={[styles.notice, { backgroundColor: appearance.backgroundColor }]} accessibilityLiveRegion="polite">
      {tone === 'success' && <Icon name="check" color={appearance.color} size={18} />}
      <Text style={[styles.text, { color: tone === 'info' ? colors.textSecondary : appearance.color }]}
        accessibilityRole={tone === 'error' ? 'alert' : undefined}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 11 },
  text: { flex: 1, fontFamily: fonts.medium, fontSize: 14, lineHeight: 21 },
});
