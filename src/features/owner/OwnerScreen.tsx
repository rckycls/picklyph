import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/theme/colors';

/** Scrolling, keyboard-safe body under the owner stack header. */
export function OwnerScreen({ children, includeTop = false }: { children: ReactNode; includeTop?: boolean }) {
  return (
    <SafeAreaView style={styles.screen} edges={includeTop ? ['top', 'left', 'right', 'bottom'] : ['left', 'right', 'bottom']}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={96}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', padding: 20, gap: 18 },
});
