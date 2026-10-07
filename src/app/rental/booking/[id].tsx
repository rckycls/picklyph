import { useLocalSearchParams } from 'expo-router';
import { RentalDetail } from '@/features/rental/Detail';
import { RentalGate } from '@/features/rental/ui';
export default function RentalBookingRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RentalGate>{(actor) => <RentalDetail key={`${actor}:${id}`} actor={actor} bookingId={id} />}</RentalGate>;
}
