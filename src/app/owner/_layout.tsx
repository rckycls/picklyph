import { Redirect, Stack } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useAuth } from '@/features/auth/AuthProvider';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

/** Owner submissions need a signed-in account; the server verifies the token again on every command. */
export default function OwnerLayout() {
  const { session, status } = useAuth();
  if (status === 'restoring') {
    return <View style={styles.loading}><ActivityIndicator color={colors.primary} accessibilityLabel="Restoring your sign-in" /></View>;
  }
  if (!session) return <Redirect href="/account" />;
  return (
    <Stack screenOptions={{
      headerShown: true,
      headerBackTitle: 'Back',
      headerTintColor: colors.primary,
      headerStyle: { backgroundColor: colors.surface },
      headerTitleStyle: { fontFamily: fonts.semibold, color: colors.text },
      contentStyle: { backgroundColor: colors.background },
    }}>
      <Stack.Screen name="submit" options={{ title: 'Add a missing venue' }} />
      <Stack.Screen name="claim/[id]" options={{ title: 'Claim a listing' }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
