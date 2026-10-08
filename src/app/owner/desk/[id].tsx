import { readOperationsDate } from '@picklyph/domain';
import { useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { useAuth } from '@/features/auth/AuthProvider';
import { FrontDesk } from '@/features/owner/FrontDesk';
import { VerifiedOwnerGate } from '@/features/owner/OwnerMode';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
const validDate = (raw: unknown): string | null => { try { return readOperationsDate(raw); } catch { return null; } };
export default function DeskRoute() {
  const { id, date } = useLocalSearchParams<{ id: string; date?: string }>(); const { session } = useAuth();
  const venueId = typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
  return <VerifiedOwnerGate>{venueId && session ? <FrontDesk key={`${venueId}:${session.user.id}:${date ?? ''}`} venueId={venueId} actor={session.user.id}
    initialDate={validDate(date)} />
    : <OwnerScreen><Card><Text accessibilityRole="alert" style={screenText.body}>Open this venue from Your venues.</Text></Card></OwnerScreen>}</VerifiedOwnerGate>;
}
