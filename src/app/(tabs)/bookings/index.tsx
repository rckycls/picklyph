import { router } from 'expo-router';
import { Text } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Screen, screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';

export default function BookingsScreen() {
  return <Screen eyebrow="MORE TIME ON COURT" title="Your games, in one place."
    description="Court rentals and group open play, with the details you need before you head out.">
    <Card>
      <StatusBadge label="Bookings coming soon" tone="pending" />
      <Text accessibilityRole="header" style={screenText.title}>Good games are ahead.</Text>
      <Text style={screenText.body}>You’re signed in. Booking isn’t available yet; your upcoming games and requests will appear here when it opens.</Text>
      <Button label="Back to Discover" variant="accent" onPress={() => router.navigate('/(tabs)')} />
    </Card>
  </Screen>;
}
