import { useLocalSearchParams } from 'expo-router';
import { GroupReserve } from '@/features/openPlay/Reserve';
import { RentalGate } from '@/features/rental/ui';
export default function OpenPlaySessionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RentalGate>{(actor) => <GroupReserve key={`${actor}:${id}`} actor={actor} sessionId={id} />}</RentalGate>;
}
