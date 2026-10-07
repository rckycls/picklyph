import { useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';

import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { CourtCalendar } from '@/features/owner/CourtCalendar';
import { VerifiedOwnerGate } from '@/features/owner/OwnerMode';
import { OwnerScreen } from '@/features/owner/OwnerScreen';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function CourtCalendarRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const venueId = typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
  return (
    <VerifiedOwnerGate>
      {venueId ? <CourtCalendar key={venueId} venueId={venueId} /> : (
        <OwnerScreen>
          <Card><Text accessibilityRole="alert" style={screenText.body}>This venue link isn’t valid. Open the venue from Your venues.</Text></Card>
        </OwnerScreen>
      )}
    </VerifiedOwnerGate>
  );
}
