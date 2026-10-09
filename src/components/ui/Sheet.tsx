import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { Icon } from './Icon';

/**
 * Runs an action (usually navigation) after the sheet finishes closing, so a pushed screen isn't
 * hidden under it. Pass `onDismiss` to the Sheet; the timer covers a dismissal that never reports.
 */
export function useAfterSheetClose() {
  const pending = useRef<(() => void) | null>(null);
  const onDismiss = useCallback(() => { const action = pending.current; pending.current = null; action?.(); }, []);
  const after = useCallback((action: () => void) => { pending.current = action; setTimeout(onDismiss, 700); }, [onDismiss]);
  return { after, onDismiss };
}

/** A bottom sheet for short, focused actions on top of the current screen. */
export function Sheet({ visible, title, subtitle, onClose, onDismiss, children }: {
  visible: boolean; title: string; subtitle?: string; onClose: () => void; onDismiss?: () => void; children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [offset] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!visible) return;
    if (reduced) { offset.setValue(0); return; }
    offset.setValue(1);
    Animated.timing(offset, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [visible, reduced, offset]);
  const translateY = useMemo(() => offset.interpolate({ inputRange: [0, 1], outputRange: [0, 420] }), [offset]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={onDismiss} statusBarTranslucent>
      <View style={styles.root}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} />
        <Animated.View accessibilityViewIsModal style={[styles.panel, { paddingBottom: Math.max(insets.bottom, 16) + 4, transform: [{ translateY }] }]}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <View style={styles.heading}>
              <Text accessibilityRole="header" style={styles.title}>{title}</Text>
              {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={6}
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
              <Icon name="close" color={colors.textSecondary} size={20} />
            </Pressable>
          </View>
          <ScrollView bounces={false} style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim },
  panel: { maxHeight: '86%', backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 8 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 22, paddingTop: 6, paddingBottom: 10 },
  heading: { flex: 1, gap: 2 },
  title: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 20, lineHeight: 26, letterSpacing: -0.3 },
  subtitle: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  close: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  pressed: { opacity: 0.7 },
  // Shrinks inside the panel's max height, so long content scrolls instead of overflowing.
  scroll: { flexShrink: 1 },
  body: { paddingHorizontal: 22, paddingBottom: 8, gap: 14 },
});
