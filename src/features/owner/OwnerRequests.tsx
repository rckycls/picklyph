import { formatManilaDateTime, formatPhpCentavos } from '@picklyph/domain';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { usePages } from '../openPlay/usePages';
import { decide, deskEnd, deskFailureMessage, deskStart, deskTotal, loadRequests, mergeDesk, shortReference,
  type DeskBooking, type DeskFailure, type DeskKind, type DeskPage, type DeskReason } from './deskClient';
import { deskServices } from './deskLive';
import { OwnerScreen } from './OwnerScreen';

/** One queue for pending rental and open-play requests. Holds expire on the server; nothing here changes status locally. */
export function OwnerRequests({ actor, venueId }: { actor: string; venueId: string }) {
  const { transports } = useMemo(() => deskServices(actor), [actor]);
  const [venue, setVenue] = useState<VenueDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null); const [failure, setFailure] = useState<DeskFailure | null>(null);
  const [message, setMessage] = useState<string | null>(null); const lock = useRef(false); const alive = useRef(false);
  const loadRentals = useCallback((after: string | null, signal: AbortSignal) => loadRequests(transports, 'rental', venueId, after, signal), [transports, venueId]);
  const loadGroups = useCallback((after: string | null, signal: AbortSignal) => loadRequests(transports, 'group', venueId, after, signal), [transports, venueId]);
  const rentals = usePages<DeskPage, DeskBooking, DeskReason>(loadRentals, mergeDesk);
  const groups = usePages<DeskPage, DeskBooking, DeskReason>(loadGroups, mergeDesk);
  useFocusEffect(useCallback(() => {
    alive.current = true; const abort = new AbortController();
    void loadLiveVenueDetail(venueId, abort.signal).then((v) => { if (!abort.signal.aborted) setVenue(v); }).catch(() => {});
    return () => { alive.current = false; abort.abort(); };
  }, [venueId]));
  const act = async (item: DeskBooking, decision: 'accept' | 'decline') => {
    if (lock.current) return;
    lock.current = true; setBusy(item.booking.id); setFailure(null); setMessage(null);
    try {
      const result = await decide(transports, item.kind, item.booking.id, decision);
      if (!alive.current) return;
      if (!result.ok) setFailure(result.failure);
      else setMessage(result.value.outcome === 'expired' ? 'That hold had already ended, so the request expired.'
        : decision === 'accept' ? 'Request accepted. The booking is confirmed; payment is still due at the venue.' : 'Request declined. Its court time or spots are open again.');
      rentals.refresh(); groups.refresh();
    } finally { lock.current = false; if (alive.current) setBusy(null); }
  };
  const confirmDecline = (item: DeskBooking) => Alert.alert('Decline this request?', 'The player is told it was declined, and the court time or spots open again.',
    [{ text: 'Keep request', style: 'cancel' }, { text: 'Decline', style: 'destructive', onPress: () => void act(item, 'decline') }]);
  const courtName = (courtId: string) => venue?.courts.find((c) => c.id === courtId)?.name ?? 'Court';
  const section = (kind: DeskKind, list: typeof rentals) => <View style={{ gap: 12 }}>
    <Text accessibilityRole="header" style={screenText.label}>{kind === 'rental' ? 'Court rentals' : 'Open-play groups'}</Text>
    {list.failure && <Card><Text accessibilityLiveRegion="polite" style={screenText.body}>{deskFailureMessage(list.failure)}</Text>
      <Button label="Retry" variant="secondary" onPress={list.refresh} /></Card>}
    {list.loaded && !list.rows.length && <Text style={screenText.body}>No pending {kind === 'rental' ? 'rental' : 'group'} requests.</Text>}
    {list.rows.map((item) => <Card key={item.booking.id}>
      <StatusBadge label="Awaiting your decision" tone="pending" />
      <Text style={screenText.label}>{item.kind === 'rental' ? courtName(item.booking.allocation.court_id) : item.booking.snapshot.title}</Text>
      <Text style={screenText.body}>{formatManilaDateTime(deskStart(item))} → {formatManilaDateTime(deskEnd(item))} (Manila)</Text>
      {item.kind === 'group' && <Text style={screenText.body}>{item.booking.spots} {item.booking.spots === 1 ? 'person' : 'people'}: {item.booking.participants.join(', ')}</Text>}
      <Text style={screenText.body}>{formatPhpCentavos(deskTotal(item))} due at the venue · Ref {shortReference(item.booking.id)}</Text>
      {(item.kind === 'rental' ? item.booking.allocation.expires_at : item.booking.expires_at) && <Text style={screenText.body}>
        Hold ends {formatManilaDateTime((item.kind === 'rental' ? item.booking.allocation.expires_at : item.booking.expires_at)!)}; it expires unless you accept first.</Text>}
      <Button label="Accept" loading={busy === item.booking.id} disabled={Boolean(busy)} onPress={() => void act(item, 'accept')} />
      <Button label="Decline" variant="secondary" disabled={Boolean(busy)} onPress={() => confirmDecline(item)} />
    </Card>)}
    {list.cursor && <Button label="Load more" variant="secondary" disabled={list.busy} onPress={list.more} />}
  </View>;
  return <OwnerScreen>
    <Text style={screenText.title}>{venue?.name ?? 'Booking requests'}</Text>
    <Text style={screenText.body}>Requests hold the court or spots for up to 2 hours, capped at the start time. Accepting confirms the booking; payment stays due at the venue.</Text>
    <Button label={rentals.busy || groups.busy ? 'Checking requests…' : 'Refresh requests'} variant="secondary" loading={rentals.busy || groups.busy}
      onPress={() => { rentals.refresh(); groups.refresh(); }} />
    {failure && <Card><Text accessibilityLiveRegion="polite" style={screenText.body}>{deskFailureMessage(failure)}</Text></Card>}
    {message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
    {section('rental', rentals)}
    {section('group', groups)}
  </OwnerScreen>;
}
