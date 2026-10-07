import type { RentalBooking } from '@picklyph/domain';
import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { PicklyMascot } from '@/components/mascot/PicklyMascot';
import { rentalCelebrations } from './celebration';

export function BookingMascot({ actor, booking, fresh }: { actor: string; booking: RentalBooking; fresh: boolean }) {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [celebrating, setCelebrating] = useState(false);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => {
      if (!alive) return;
      // Refresh/cancellation uncertainty ends a celebration; subsequent reads cannot replay it.
      if (!fresh || booking.status !== 'confirmed') setCelebrating(false);
      if (focused && foreground && rentalCelebrations.observe(actor, booking, fresh)) setCelebrating(true);
    });
    return () => { alive = false; };
  }, [actor, booking, fresh, focused, foreground]);
  if (booking.status !== 'pending' && booking.status !== 'confirmed') return null;
  const cheer = celebrating && booking.status === 'confirmed' && fresh;
  return <View style={{ alignItems: 'center' }}>
    <PicklyMascot pose={cheer ? 'cheer' : 'idle'} playback={cheer ? 'once' : 'loop'} size={140} />
  </View>;
}
