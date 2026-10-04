import { router } from 'expo-router';
import { Text } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen, screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';

export default function BookingsScreen() {
  return (
    <Screen
      eyebrow="MORE TIME ON COURT"
      title="Your games, in one place."
      description="Court rentals and group open play, with the details you need before you head out."
    >
      <Card>
        <StatusBadge label="Bookings coming soon" tone="pending" />
        <Text accessibilityRole="header" style={screenText.title}>Good games are ahead.</Text>
        <Text style={screenText.body}>
          Booking isn’t available yet. When it opens, you’ll find your upcoming games, requests, and booking history here.
        </Text>
        <Button label="Back to Discover" variant="accent" onPress={() => router.navigate('/(tabs)')} />
      </Card>
      <Card tone="highlight">
        <Text accessibilityRole="header" style={screenText.title}>One account. Every game.</Text>
        <Text style={screenText.body}>You’ll be able to browse as a guest and sign in when you’re ready to book.</Text>
        <Button label="View account" variant="secondary" onPress={() => router.navigate('/(tabs)/account')} />
      </Card>
    </Screen>
  );
}
