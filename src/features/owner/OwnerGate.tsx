import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { colors } from '@/theme/colors';

/**
 * Owner screens need a signed-in account; the server verifies the token again on every command.
 * Each owner route wraps itself in this gate instead of a nested owner stack, so the root
 * stack keeps the native back button.
 */
export function OwnerGate({ children }: { children: ReactNode }) {
  const { session, status } = useAuth();
  if (status === 'restoring') {
    return <View style={styles.loading}><ActivityIndicator color={colors.primary} accessibilityLabel="Restoring your sign-in" /></View>;
  }
  if (!session) return <Redirect href="/account" />;
  return children;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
