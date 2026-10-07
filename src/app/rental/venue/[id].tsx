import { useLocalSearchParams } from 'expo-router';
import { RentalSelection } from '@/features/rental/Selection';
import { RentalGate } from '@/features/rental/ui';
export default function RentalVenueRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RentalGate>{(actor) => <RentalSelection key={`${actor}:${id}`} actor={actor} venueId={id} />}</RentalGate>;
}
