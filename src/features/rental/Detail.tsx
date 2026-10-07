import { type RentalBooking } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Text } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { cancelRental, loadBooking, type RentalFailure } from './client';
import { rentalServices } from './live';
import { BookingSummary, PriceReview, RentalError } from './ui';
import { useRentalRead } from './useRentalRead';
import { useRetryWait } from './useRetryWait';

export function RentalDetail({ actor, bookingId }: { actor: string; bookingId: string }) {
  const services = useMemo(() => rentalServices(actor), [actor]);
  const read = useCallback((signal: AbortSignal) => loadBooking(services.transport, bookingId, signal), [services, bookingId]);
  const state = useRentalRead<RentalBooking>(read, 30);
  const [venue, setVenue] = useState<VenueDetail | null>(null);
  const [changing, setChanging] = useState(false); const [failure, setFailure] = useState<RentalFailure | null>(null);
  const [cancelUncertain, setCancelUncertain] = useState(false); const lock = useRef(false); const alive = useRef(false);
  const wait = useRetryWait(failure ?? state.failure);
  const venueId = state.value?.allocation.venue_id;
  useFocusEffect(useCallback(() => {
    alive.current = true; const abort = new AbortController();
    if (venueId) void loadLiveVenueDetail(venueId, abort.signal).then((v) => { if (!abort.signal.aborted) setVenue(v); }).catch(() => {});
    return () => { alive.current = false; abort.abort(); };
  }, [venueId]));
  const cancel = async () => {
    if (!alive.current || lock.current) return;
    lock.current = true; setChanging(true); setFailure(null);
    try {
      const result = await cancelRental(services.transport, bookingId);
      if (!alive.current) return;
      if (!result.ok) { setFailure(result.failure); setCancelUncertain(result.failure.kind !== 'rejected'); }
      else setCancelUncertain(false);
      state.refresh();
    } finally { lock.current = false; if (alive.current) setChanging(false); }
  };
  const confirmCancel = () => Alert.alert('Cancel this rental?', 'This releases your reservation. To change the time, cancel and reserve again. No online payment was collected.',
    [{ text: 'Keep booking', style: 'cancel' }, { text: 'Cancel rental', style: 'destructive', onPress: () => void cancel() }]);
  const b = state.value; const canCancel = b && (b.status === 'pending' || b.status === 'confirmed');
  return <OwnerScreen><Text style={screenText.title}>{venue?.name ?? 'Rental details'}</Text>
    {b && <Text style={screenText.label}>{venue?.courts.find((c) => c.id === b.allocation.court_id)?.name ?? `Court ${b.allocation.court_id}`}</Text>}
    {venue && <Text style={screenText.body}>Current listing: {venue.address_line}, {venue.city}, {venue.province}</Text>}
    <Button label={wait ? `Refresh in ${wait}s` : state.busy ? 'Checking current status…' : 'Refresh status'} variant="secondary" loading={state.busy} disabled={changing || wait > 0} onPress={state.refresh} />
    {state.failure && <RentalError failure={state.failure} />}{failure && <RentalError failure={failure} />}
    {(state.busy || state.failure) && <Text accessibilityLiveRegion="polite" style={screenText.body}>Any details below are the last received record. Refresh to check the server’s current status.</Text>}
    {b && <><BookingSummary booking={b} /><PriceReview value={b.snapshot} />
      <Text style={screenText.body}>The total and policy above were saved with this booking and do not change with current venue rates.</Text>
      {canCancel && <Button label={cancelUncertain ? 'Retry original cancellation' : 'Cancel rental'} variant="secondary" loading={changing}
        disabled={state.busy || wait > 0 || Boolean(state.failure)} onPress={cancelUncertain ? () => void cancel() : confirmCancel} />}
      {!canCancel && <Button label="Choose another rental" variant="accent" onPress={() => router.push({ pathname: '/rental/venue/[id]', params: { id: b.allocation.venue_id } })} />}
    </>}
    {cancelUncertain && <Card><Text style={screenText.body}>Cancellation has no confirmed reply. Refresh this booking or retry the same cancellation to check; avoid making a replacement reservation until its status is clear.</Text></Card>}
    <Button label="Your bookings" variant="secondary" onPress={() => router.navigate('/bookings')} />
  </OwnerScreen>;
}
