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
import { PushRegistration } from '@/features/notifications/usePushRegistration';
import { OwnerModeProvider } from '@/features/owner/OwnerMode';

// Owner screens sit directly in the root stack (no nested owner stack), so the first one
// opened from a tab still gets the native back button. Each route checks its required access.
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
        <PushRegistration />
        <OwnerModeProvider>
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="welcome" options={{ gestureEnabled: false, animation: 'none' }} />
            <Stack.Screen name="rental/venue/[id]" options={ownerHeader('Reserve a court')} />
            <Stack.Screen name="rental/booking/[id]" options={ownerHeader('Rental booking')} />
            <Stack.Screen name="play/venue/[id]" options={ownerHeader('Open play')} />
            <Stack.Screen name="play/session/[id]" options={ownerHeader('Join open play')} />
            <Stack.Screen name="play/booking/[id]" options={ownerHeader('Open-play group')} />
            <Stack.Screen name="preferences" options={ownerHeader('Preferences')} />
            <Stack.Screen name="delete-account" options={ownerHeader('Delete account')} />
            <Stack.Screen name="report/[id]" options={ownerHeader('Report a listing')} />
            <Stack.Screen name="owner/submit" options={ownerHeader('Add your venue')} />
            <Stack.Screen name="owner/claim/[id]" options={ownerHeader('Claim a listing')} />
            <Stack.Screen name="owner/venues/index" options={ownerHeader('Your venues')} />
            <Stack.Screen name="owner/venues/[id]" options={ownerHeader('Edit venue')} />
            <Stack.Screen name="owner/calendar/[id]" options={ownerHeader('Court calendar')} />
            <Stack.Screen name="owner/hours/[id]" options={ownerHeader('Hours and closures')} />
            <Stack.Screen name="owner/sessions/[id]" options={ownerHeader('Open-play sessions')} />
            <Stack.Screen name="owner/requests/[id]" options={ownerHeader('Booking requests')} />
            <Stack.Screen name="owner/desk/[id]" options={ownerHeader('Front desk')} />
            <Stack.Screen name="owner/entry/[id]" options={ownerHeader('Outside booking')} />
          </Stack>
        </OwnerModeProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', gap: 16 },
  loadingText: { color: colors.textSecondary, fontSize: 15 },
});
