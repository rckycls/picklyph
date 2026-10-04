import { router } from 'expo-router';
import { Text } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CourtArtwork } from '@/components/ui/CourtArtwork';
import { Field } from '@/components/ui/Field';
import { Screen, screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';

export default function DiscoverScreen() {
  return (
    <Screen
      eyebrow="FIND YOUR PLACE TO PLAY"
      title="Your next game starts here."
      description="A court around the corner. A game with your crew. More pickleball, across the Philippines."
    >
      <CourtArtwork />
      <Card>
        <StatusBadge label="Coming soon" tone="pending" />
        <Text accessibilityRole="header" style={screenText.title}>Find a court, find your people.</Text>
        <Text style={screenText.body}>
          Explore courts on the map and find private rentals or group open play. Court discovery is on the way.
        </Text>
        <Field
          label="City or court name"
          placeholder="Try Makati, Cebu, or Davao"
          editable={false}
          hint="Search will be available when court discovery opens."
        />
      </Card>
      <Card tone="highlight">
        <Text accessibilityRole="header" style={screenText.title}>Make room for more games.</Text>
        <Text style={screenText.body}>Your court rentals and open-play reservations will have a home here.</Text>
        <Button label="View bookings" onPress={() => router.navigate('/(tabs)/bookings')} />
      </Card>
    </Screen>
  );
}
