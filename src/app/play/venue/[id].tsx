import { useLocalSearchParams } from 'expo-router';
import { SessionList } from '@/features/openPlay/Sessions';
import { RentalGate } from '@/features/rental/ui';
export default function OpenPlayVenueRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RentalGate>{(actor) => <SessionList key={`${actor}:${id}`} actor={actor} venueId={id} />}</RentalGate>;
}
