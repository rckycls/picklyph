import { useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { useAuth } from '@/features/auth/AuthProvider';
import { VerifiedOwnerGate } from '@/features/owner/OwnerMode';
import { OwnerRequests } from '@/features/owner/OwnerRequests';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
export default function RequestsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>(); const { session } = useAuth();
  const venueId = typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
  return <VerifiedOwnerGate>{venueId && session ? <OwnerRequests key={`${venueId}:${session.user.id}`} venueId={venueId} actor={session.user.id} />
    : <OwnerScreen><Card><Text accessibilityRole="alert" style={screenText.body}>Open this venue from Your venues.</Text></Card></OwnerScreen>}</VerifiedOwnerGate>;
}
