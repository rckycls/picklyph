import type { SessionBooking } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Text } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { BookingMascot } from '../rental/BookingMascot';
import { useRentalRead } from '../rental/useRentalRead';
import { useRetryWait } from '../rental/useRetryWait';
import { cancelGroup, loadGroupBooking, type GroupFailure, type GroupReason } from './client';
import { openPlayServices } from './live';
import { GroupError, GroupReview, GroupSummary, SessionTimes } from './ui';

export function GroupDetail({ actor, bookingId }: { actor: string; bookingId: string }) {
  const services = useMemo(() => openPlayServices(actor), [actor]);
  const read = useCallback((signal: AbortSignal) => loadGroupBooking(services.transport, bookingId, signal), [services, bookingId]);
  const state = useRentalRead<SessionBooking, GroupReason>(read, 30);
  const [venue, setVenue] = useState<VenueDetail | null>(null);
  const [changing, setChanging] = useState(false); const [failure, setFailure] = useState<GroupFailure | null>(null);
  const [cancelUncertain, setCancelUncertain] = useState(false); const lock = useRef(false); const alive = useRef(false);
  const wait = useRetryWait(failure ?? state.failure);
  const venueId = state.value?.snapshot.venue_id;
  useFocusEffect(useCallback(() => {
    alive.current = true; const abort = new AbortController();
    if (venueId) void loadLiveVenueDetail(venueId, abort.signal).then((v) => { if (!abort.signal.aborted) setVenue(v); }).catch(() => {});
    return () => { alive.current = false; abort.abort(); };
  }, [venueId]));
  const cancel = async () => {
    if (!alive.current || lock.current) return;
    lock.current = true; setChanging(true); setFailure(null);
    try {
      const result = await cancelGroup(services.transport, bookingId);
      if (!alive.current) return;
      if (!result.ok) { setFailure(result.failure); setCancelUncertain(result.failure.kind !== 'rejected'); }
      else setCancelUncertain(false);
      state.refresh();
    } finally { lock.current = false; if (alive.current) setChanging(false); }
  };
  const confirmCancel = () => Alert.alert('Cancel this group?', 'This releases every spot in the group. To change names, cancel and reserve again. No online payment was collected.',
    [{ text: 'Keep group', style: 'cancel' }, { text: 'Cancel group', style: 'destructive', onPress: () => void cancel() }]);
  const b = state.value; const canCancel = b && b.source === 'player' && (b.status === 'pending' || b.status === 'confirmed');
  return <OwnerScreen><Text style={screenText.title}>{b?.snapshot.title ?? 'Open-play booking'}</Text>
    {venue && <Text style={screenText.label}>{venue.name}</Text>}
    {venue && <Text style={screenText.body}>Current listing: {venue.address_line}, {venue.city}, {venue.province}</Text>}
    <Button label={wait ? `Refresh in ${wait}s` : state.busy ? 'Checking current status…' : 'Refresh status'} variant="secondary" loading={state.busy} disabled={changing || wait > 0} onPress={state.refresh} />
    {state.failure && <GroupError failure={state.failure} />}{failure && <GroupError failure={failure} />}
    {(state.busy || state.failure) && <Text accessibilityLiveRegion="polite" style={screenText.body}>Any details below are the last received record. Refresh to check the server’s current status.</Text>}
    {b && <><GroupSummary booking={b}><BookingMascot actor={actor} booking={b} fresh={!state.busy && !state.failure && !failure && !cancelUncertain && !changing} /></GroupSummary>
      <Card><SessionTimes snapshot={b.snapshot} venue={venue} /></Card>
      <GroupReview snapshot={b.snapshot} names={b.participants} total={b.snapshot.total_centavos} />
      <Text style={screenText.body}>The names, total and policy above were saved with this booking and do not change with later venue edits.</Text>
      {canCancel && <Button label={cancelUncertain ? 'Retry original cancellation' : 'Cancel group'} variant="secondary" loading={changing}
        disabled={state.busy || wait > 0 || Boolean(state.failure)} onPress={cancelUncertain ? () => void cancel() : confirmCancel} />}
      {!canCancel && <Button label="Find another session" variant="accent" onPress={() => router.push({ pathname: '/play/venue/[id]', params: { id: b.snapshot.venue_id } })} />}
    </>}
    {cancelUncertain && <Card><Text style={screenText.body}>Cancellation has no confirmed reply. Refresh this booking or retry the same cancellation to check; avoid reserving a replacement group until its status is clear.</Text></Card>}
    <Button label="Your open-play bookings" variant="secondary" onPress={() => router.navigate({ pathname: '/bookings', params: { view: 'play' } })} />
  </OwnerScreen>;
}
