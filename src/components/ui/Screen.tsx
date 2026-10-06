import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/theme/colors';

export function Screen({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.keyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.content}>
            <View style={styles.brand}>
              <View style={styles.dot} accessible={false} />
              <Text style={styles.brandName}>PicklyPH</Text>
              <Text style={styles.country}>PH</Text>
            </View>
            <View style={styles.heading}>
              <Text style={styles.eyebrow}>{eyebrow}</Text>
              <Text accessibilityRole="header" style={styles.title}>{title}</Text>
              <Text style={styles.description}>{description}</Text>
            </View>
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export const screenText = StyleSheet.create({
  title: { color: colors.text, fontSize: 21, lineHeight: 28, fontWeight: '700', letterSpacing: -0.4 },
  body: { color: colors.textSecondary, fontSize: 15, lineHeight: 24 },
  label: { color: colors.text, fontSize: 14, lineHeight: 21, fontWeight: '700' },
});

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, alignItems: 'center' },
  content: { width: '100%', maxWidth: 560, padding: 24, gap: 24 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  dot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.secondary },
  brandName: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.8 },
  country: { marginLeft: 'auto', color: colors.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  heading: { gap: 10 },
  eyebrow: { color: colors.link, fontSize: 11, lineHeight: 17, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: colors.text, fontSize: 34, lineHeight: 40, fontWeight: '800', letterSpacing: -1.2 },
  description: { color: colors.textSecondary, fontSize: 16, lineHeight: 25 },
});
