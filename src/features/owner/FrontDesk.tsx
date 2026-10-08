import { ARRIVAL_PAYMENT_METHODS, formatManilaDateTime, formatPhpCentavos, toManilaDateTime,
  type ArrivalPaymentMethod, type BookingOperationCommand } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { usePages } from '../openPlay/usePages';
import { deskEnd, deskFailureMessage, deskStart, deskTotal, loadDay, mergeDesk, operate, shiftDate, shortReference,
  type DeskBooking, type DeskFailure, type DeskKind, type DeskPage, type DeskReason } from './deskClient';
import { deskServices } from './deskLive';
import { attendanceText, availableOperations, PAYMENT_METHOD_LABELS, paymentText } from './operationsModel';
import { OwnerScreen } from './OwnerScreen';

/** Confirmed bookings starting on one Manila date. Records open at each booking's start by the server's clock. */
export function FrontDesk({ actor, venueId, initialDate }: { actor: string; venueId: string; initialDate: string | null }) {
  const { transports } = useMemo(() => deskServices(actor), [actor]);
  const today = toManilaDateTime(new Date()).date;
  const [date, setDate] = useState(initialDate ?? today); const [at, setAt] = useState<string | null>(null);
  const [venue, setVenue] = useState<VenueDetail | null>(null); const [paying, setPaying] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); const [failure, setFailure] = useState<DeskFailure | null>(null);
  const [message, setMessage] = useState<string | null>(null); const lock = useRef(false); const alive = useRef(false);
  const day = useCallback((kind: DeskKind) => async (after: string | null, signal: AbortSignal) => {
    const result = await loadDay(transports, kind, venueId, date, after, signal);
    if (result.ok && result.value.at && !signal.aborted) setAt(result.value.at);
    return result;
  }, [transports, venueId, date]);
  const loadRentals = useMemo(() => day('rental'), [day]); const loadGroups = useMemo(() => day('group'), [day]);
  const rentals = usePages<DeskPage, DeskBooking, DeskReason>(loadRentals, mergeDesk);
  const groups = usePages<DeskPage, DeskBooking, DeskReason>(loadGroups, mergeDesk);
  useFocusEffect(useCallback(() => {
    alive.current = true; const abort = new AbortController();
    void loadLiveVenueDetail(venueId, abort.signal).then((v) => { if (!abort.signal.aborted) setVenue(v); }).catch(() => {});
    return () => { alive.current = false; abort.abort(); };
  }, [venueId]));
  const move = (next: string) => { setPaying(null); setFailure(null); setMessage(null); setAt(null); setDate(next); };
  const run = async (item: DeskBooking, command: BookingOperationCommand, done: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(item.booking.id); setFailure(null); setMessage(null);
    try {
      const result = await operate(transports, item.kind, command);
      if (!alive.current) return;
      if (result.ok) { setMessage(done); setPaying(null); } else setFailure(result.failure);
      (item.kind === 'rental' ? rentals : groups).refresh();
    } finally { lock.current = false; if (alive.current) setBusy(null); }
  };
  const confirmNoShow = (item: DeskBooking) => Alert.alert('Mark as no-show?', 'This can’t be undone. The booking stays confirmed and no payment is recorded.',
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Mark no-show', style: 'destructive',
      onPress: () => void run(item, { kind: 'no_show', booking_id: item.booking.id }, 'Marked as no-show.') }]);
  const confirmPayment = (item: DeskBooking, method: ArrivalPaymentMethod) => Alert.alert('Record this payment?',
    `${formatPhpCentavos(deskTotal(item))} paid by ${PAYMENT_METHOD_LABELS[method].toLowerCase()}. A recorded payment can’t be changed here.`,
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Record payment', onPress: () => void run(item,
      { kind: 'record_payment', booking_id: item.booking.id, method, amount_centavos: deskTotal(item) }, 'Payment recorded.') }]);
  const label = (item: DeskBooking) => item.kind === 'rental'
    ? `${venue?.courts.find((c) => c.id === item.booking.allocation.court_id)?.name ?? 'Court'} · ${item.booking.source === 'owner' ? `${item.booking.guest_name} (outside booking)` : 'Player rental'}`
    : `${item.booking.snapshot.title} · ${item.booking.source === 'walk_in' ? 'Walk-in' : 'Player group'}`;
  const row = (item: DeskBooking) => {
    const ops = item.booking.operations; const started = at !== null && at >= deskStart(item);
    const can = availableOperations(ops, started); const working = busy === item.booking.id;
    return <Card key={item.booking.id}>
      <Text style={screenText.label}>{label(item)}</Text>
      <Text style={screenText.body}>{formatManilaDateTime(deskStart(item))} → {formatManilaDateTime(deskEnd(item))} · Ref {shortReference(item.booking.id)}</Text>
      {item.kind === 'group' && <Text style={screenText.body}>{item.booking.participants.join(', ')}</Text>}
      <Text style={screenText.body}>{attendanceText(ops)}</Text>
      <Text style={screenText.body}>{paymentText(ops)}{ops.payment ? '' : ` · ${formatPhpCentavos(deskTotal(item))} due`}</Text>
      {!started && ops.attendance === 'none' && <Text style={screenText.body}>Check-in, no-shows and payments open at the start time.</Text>}
      {can.checkIn && <Button label="Check in" loading={working} disabled={Boolean(busy)}
        onPress={() => void run(item, { kind: 'check_in', booking_id: item.booking.id }, 'Checked in.')} />}
      {can.complete && <Button label="Mark completed" loading={working} disabled={Boolean(busy)}
        onPress={() => void run(item, { kind: 'complete', booking_id: item.booking.id }, 'Marked completed.')} />}
      {can.pay && paying !== item.booking.id && <Button label={`Record ${formatPhpCentavos(deskTotal(item))} payment`} variant="secondary"
        disabled={Boolean(busy)} onPress={() => setPaying(item.booking.id)} />}
      {can.pay && paying === item.booking.id && <View style={{ gap: 8 }}>
        <Text style={screenText.label}>How did they pay?</Text>
        {ARRIVAL_PAYMENT_METHODS.map((method) => <Button key={method} label={PAYMENT_METHOD_LABELS[method]} variant="secondary"
          disabled={Boolean(busy)} onPress={() => confirmPayment(item, method)} />)}
        <Button label="Not now" variant="secondary" onPress={() => setPaying(null)} />
      </View>}
      {can.noShow && <Button label="Mark no-show" variant="secondary" disabled={Boolean(busy)} onPress={() => confirmNoShow(item)} />}
    </Card>;
  };
  const list = (kind: DeskKind, pages: typeof rentals) => <View style={{ gap: 12 }}>
    <Text accessibilityRole="header" style={screenText.label}>{kind === 'rental' ? 'Court rentals' : 'Open-play groups'}</Text>
    {pages.failure && <Card><Text accessibilityLiveRegion="polite" style={screenText.body}>{deskFailureMessage(pages.failure)}</Text>
      <Button label="Retry" variant="secondary" onPress={pages.refresh} /></Card>}
    {pages.loaded && !pages.rows.length && <Text style={screenText.body}>No confirmed {kind === 'rental' ? 'rentals' : 'groups'} start on this date.</Text>}
    {pages.rows.map(row)}
    {pages.cursor && <Button label="Load more" variant="secondary" disabled={pages.busy} onPress={pages.more} />}
  </View>;
  return <OwnerScreen>
    <Text style={screenText.title}>{venue?.name ?? 'Front desk'}</Text>
    <Text accessibilityRole="header" style={screenText.label}>{date === today ? `Today · ${date}` : date} (Manila)</Text>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <View style={{ flex: 1 }}><Button label="Previous day" variant="secondary" onPress={() => move(shiftDate(date, -1))} /></View>
      <View style={{ flex: 1 }}><Button label="Next day" variant="secondary" onPress={() => move(shiftDate(date, 1))} /></View>
    </View>
    {date !== today && <Button label="Back to today" variant="secondary" onPress={() => move(today)} />}
    <Button label="Record an outside booking" variant="accent" onPress={() => router.push({ pathname: '/owner/entry/[id]', params: { id: venueId } })} />
    <Text style={screenText.body}>Attendance and payments are records only: they never change a booking’s status or saved total, and pickly collects no money here.</Text>
    <Button label={rentals.busy || groups.busy ? 'Checking bookings…' : 'Refresh'} variant="secondary" loading={rentals.busy || groups.busy}
      onPress={() => { rentals.refresh(); groups.refresh(); }} />
    {failure && <Card><Text accessibilityLiveRegion="polite" style={screenText.body}>{deskFailureMessage(failure)}</Text></Card>}
    {message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
    {list('rental', rentals)}
    {list('group', groups)}
  </OwnerScreen>;
}
