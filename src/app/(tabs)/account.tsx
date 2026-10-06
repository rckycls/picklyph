import { router } from 'expo-router';
import { Text } from 'react-native';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen, screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { SignInForm } from '@/features/auth/SignInForm';
import { useAuth } from '@/features/auth/AuthProvider';

export default function AccountScreen() {
  const auth = useAuth();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  return (
    <Screen
      eyebrow="PLAYERS & COURT OWNERS"
      title="Welcome to the court."
      description="Find your next game or give players a place to play. PicklyPH brings both sides together."
    >
      {auth.session && auth.status === 'ready' ? <Card>
        <StatusBadge label="Signed in" tone="success" />
        <Text accessibilityRole="header" style={screenText.title}>Welcome back.</Text>
        <Text style={screenText.body}>{auth.session.user.email ?? 'Your Apple account'}</Text>
        {signOutError && <Text accessibilityRole="alert" style={screenText.body}>{signOutError}</Text>}
        <Button label="Sign out of this phone" loading={auth.busy} onPress={() => {
          setSignOutError(null);
          void auth.signOut().catch(() => setSignOutError('We couldn’t sign out. Please try again.'));
        }} />
        <Button label="Go to Discover" variant="secondary" onPress={() => router.navigate('/(tabs)')} />
      </Card> : <SignInForm />}
      <Card tone="highlight">
        <Text accessibilityRole="header" style={screenText.title}>Have a court to share?</Text>
        <Text style={screenText.body}>
          Owners will use the same account to submit a court location and, after verification, manage their venue and bookings.
        </Text>
        <StatusBadge label="Owner tools coming soon" tone="pending" />
      </Card>
    </Screen>
  );
}
