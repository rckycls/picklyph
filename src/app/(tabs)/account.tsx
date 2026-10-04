import { router } from 'expo-router';
import { Text } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen, screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';

export default function AccountScreen() {
  return (
    <Screen
      eyebrow="PLAYERS & COURT OWNERS"
      title="Welcome to the court."
      description="Find your next game or give players a place to play. PicklyPH brings both sides together."
    >
      <Card>
        <StatusBadge label="Guest mode" />
        <Text accessibilityRole="header" style={screenText.title}>Start with a look around.</Text>
        <Text style={screenText.body}>
          Sign-in is coming soon. You’ll use Apple or an email verification code to book and keep track of your games.
        </Text>
        <Button label="Sign in — coming soon" disabled accessibilityHint="Sign-in is not available yet." />
        <Button label="Go to Discover" variant="secondary" onPress={() => router.navigate('/(tabs)')} />
      </Card>
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
