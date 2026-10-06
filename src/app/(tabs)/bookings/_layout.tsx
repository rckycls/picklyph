import { Stack } from 'expo-router';

import { useAuth } from '@/features/auth/AuthProvider';

export default function BookingsLayout() {
  const { session, status } = useAuth();
  const signedIn = status === 'ready' && Boolean(session);
  return <Stack screenOptions={{ headerShown: false }}>
    <Stack.Protected guard={signedIn}><Stack.Screen name="index" /></Stack.Protected>
    <Stack.Protected guard={!signedIn}><Stack.Screen name="sign-in" /></Stack.Protected>
  </Stack>;
}
