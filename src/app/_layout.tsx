import { BricolageGrotesque_500Medium } from '@expo-google-fonts/bricolage-grotesque/500Medium';
import { BricolageGrotesque_600SemiBold } from '@expo-google-fonts/bricolage-grotesque/600SemiBold';
import { BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque/800ExtraBold';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';
import { AuthProvider } from '@/features/auth/AuthProvider';

// Owner screens sit directly in the root stack (no nested owner stack), so the first one
// opened from a tab still gets the native back button. OwnerGate guards each of them.
const ownerHeader = (title: string) => ({
  headerShown: true,
  title,
  headerBackTitle: 'Back',
  headerTintColor: colors.primary,
  headerStyle: { backgroundColor: colors.surface },
  headerTitleStyle: { fontFamily: fonts.semibold, color: colors.text },
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    BricolageGrotesque_500Medium,
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_800ExtraBold,
  });
  // Asset loading is local. If it fails, keep the app usable with system fonts.
  if (!fontsLoaded && !fontError) return (
    <View style={styles.loading}>
      <StatusBar style="dark" />
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.loadingText} accessibilityLiveRegion="polite">Opening Pickly…</Text>
    </View>
  );
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="owner/submit" options={ownerHeader('Add a missing venue')} />
          <Stack.Screen name="owner/claim/[id]" options={ownerHeader('Claim a listing')} />
        </Stack>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', gap: 16 },
  loadingText: { color: colors.textSecondary, fontSize: 15 },
});
