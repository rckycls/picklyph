import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { Icon } from './Icon';

/**
 * A one-line summary row that opens to show its editor. Closed content stays mounted (only hidden),
 * so unsaved edits inside it survive closing and reopening.
 */
export function Disclosure({ title, summary, defaultOpen = false, accessory, children }: {
  title: string; summary: string; defaultOpen?: boolean; accessory?: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.item}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${title}, ${summary}`} accessibilityState={{ expanded: open }}
        accessibilityHint={open ? 'Hides these details.' : 'Shows these details to edit them.'}
        onPress={() => setOpen((value) => !value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.row, focused && styles.focused, pressed && styles.pressed]}>
        <View style={styles.text}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.summary}>{summary}</Text>
        </View>
        {accessory}
        <Icon name={open ? 'chevronUp' : 'chevronDown'} color={colors.textSecondary} size={20} />
      </Pressable>
      <View style={[styles.body, !open && styles.hidden]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  item: { borderTopWidth: 1, borderTopColor: colors.border },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderRadius: 12,
    borderWidth: 2, borderColor: 'transparent' },
  focused: { borderColor: colors.text },
  pressed: { opacity: 0.7 },
  text: { flex: 1, gap: 2 },
  title: { fontFamily: fonts.semibold, color: colors.text, fontSize: 16, lineHeight: 22 },
  summary: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  body: { gap: 10, paddingBottom: 14 },
  hidden: { display: 'none' },
});
