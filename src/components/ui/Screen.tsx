import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { PageHeader, pageLayout } from './PageHeader';

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
          <View style={[pageLayout.content, styles.content]}>
            <PageHeader />
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
  title: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 21, lineHeight: 28, letterSpacing: -0.4 },
  body: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 15, lineHeight: 24 },
  label: { fontFamily: fonts.semibold, color: colors.text, fontSize: 14, lineHeight: 21 },
});

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, alignItems: 'center' },
  content: { paddingBottom: 32, gap: 22 },
  heading: { gap: 10 },
  eyebrow: { fontFamily: fonts.semibold, color: colors.brandGreen, fontSize: 11, lineHeight: 17, letterSpacing: 1.5 },
  title: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 34, lineHeight: 40, letterSpacing: -1.2 },
  description: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 16, lineHeight: 25 },
});
