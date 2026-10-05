import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Button } from '@/components/ui/Button';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';

import type { DemoVenue } from './demoVenues';

export function VenueSheet({ venue, onClose }: { venue: DemoVenue; onClose: () => void }) {
  const { height } = useWindowDimensions();
  return (
    <View style={[styles.sheet, { maxHeight: height * 0.36 }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <StatusBadge label="Demo location · not bookable" tone="pending" />
        <Text accessibilityRole="header" style={screenText.title}>{venue.name}</Text>
        <Text style={screenText.body}>
          An illustrative venue near {venue.city}. This isn’t a real court listing, and no bookings are available here.
        </Text>
        <Button label="Close details" variant="secondary" onPress={onClose} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
  content: { padding: 20, gap: 12 },
});
