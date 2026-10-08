import { useLocalSearchParams } from 'expo-router';
import { GroupDetail } from '@/features/openPlay/Detail';
import { RentalGate } from '@/features/rental/ui';
export default function OpenPlayBookingRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RentalGate>{(actor) => <GroupDetail key={`${actor}:${id}`} actor={actor} bookingId={id} />}</RentalGate>;
}
