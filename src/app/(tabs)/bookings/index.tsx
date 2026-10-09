import { router, useLocalSearchParams } from 'expo-router';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useAuth } from '@/features/auth/AuthProvider';
import { BookingsCalendar } from '@/features/bookings/BookingsCalendar';
import { GroupHistory } from '@/features/openPlay/History';
import { RentalHistory } from '@/features/rental/History';

const VIEWS = [
  { value: 'calendar', label: 'Calendar' },
  { value: 'rentals', label: 'Rentals', accessibilityLabel: 'Court rentals' },
  { value: 'play', label: 'Open play' },
] as const;

export default function BookingsScreen() {
  const auth = useAuth();
  const { view } = useLocalSearchParams<{ view?: string }>();
  const selected = view === 'play' ? 'play' : view === 'rentals' ? 'rentals' : 'calendar';
  if (auth.status !== 'ready' || !auth.session) return null;
  const actor = auth.session.user.id;
  return <Screen eyebrow="MORE TIME ON COURT" title="Your court time." description="Your rentals and open-play groups on a calendar, with current status and saved details. All times are in Manila.">
    <SegmentedControl options={VIEWS} value={selected} accessibilityLabel="Bookings view" onChange={(next) => router.setParams({ view: next })} />
    {selected === 'play' ? <GroupHistory key={`play:${actor}`} actor={actor} />
      : selected === 'rentals' ? <RentalHistory key={`rentals:${actor}`} actor={actor} />
        : <BookingsCalendar key={`calendar:${actor}`} actor={actor} />}
    <Button label="Discover courts" variant="accent" onPress={() => router.navigate('/(tabs)')} />
  </Screen>;
}
