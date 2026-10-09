import { ARRIVAL_PAYMENT_METHODS, formatPhpCentavos, toManilaDateTime,
  type ArrivalPaymentMethod, type BookingOperationCommand, type BookingOperations, type CalendarView } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { DateStrip } from '@/components/calendar/DateStrip';
import { DayTimeline, TimelineLegend, type TimelineColumn, type TimelineEvent } from '@/components/calendar/DayTimeline';
import { clockText, minutesFrom, shortDateText } from '@/components/calendar/dates';
import { timelineRange } from '@/components/calendar/timeline';
import { Button } from '@/components/ui/Button';
import { IconPill } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { screenText } from '@/components/ui/Screen';
import { Sheet, useAfterSheetClose } from '@/components/ui/Sheet';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';
import { usePages } from '../openPlay/usePages';
import { calendarMarks, courtDay, weekSpan } from './calendarModel';
import { deskEntries, deskSummary, entryTone, type DeskEntry } from './deskCalendar';
import { deskFailureMessage, deskStart, deskTotal, loadDay, mergeDesk, operate, shortReference,
  type DeskBooking, type DeskFailure, type DeskKind, type DeskPage, type DeskReason } from './deskClient';
import { deskServices } from './deskLive';
import { Choice } from './FormControls';
import { liveCalendar } from './liveOwner';
import { availableOperations, PAYMENT_METHOD_LABELS } from './operationsModel';
import { OwnerScreen } from './OwnerScreen';

const LEGEND = [
  { tone: 'rental', label: 'Rental' }, { tone: 'session', label: 'Open play' }, { tone: 'done', label: 'Arrived' }, { tone: 'muted', label: 'No-show' },
] as const;
const ATTENDANCE = {
  none: { label: 'Not checked in', tone: 'neutral' }, checked_in: { label: 'Checked in', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' }, no_show: { label: 'No-show', tone: 'error' },
} as const;

function entryTitle(entry: DeskEntry): string {
  const first = entry.items[0]!;
  if (first.kind === 'group') return first.booking.snapshot.title;
  return first.booking.source === 'owner' ? first.booking.guest_name ?? 'Outside booking' : 'Player rental';
}
function entryDetail(entry: DeskEntry): string {
  if (entry.kind === 'session') {
    const people = entry.items.reduce((sum, item) => sum + (item.kind === 'group' ? item.booking.spots : 0), 0);
    const arrived = entry.items.filter((item) => ['checked_in', 'completed'].includes(item.booking.operations.attendance)).length;
    return `${entry.items.length} ${entry.items.length === 1 ? 'group' : 'groups'} · ${people} ${people === 1 ? 'person' : 'people'}${arrived ? ` · ${arrived} in` : ''}`;
  }
  const item = entry.items[0]; const ops: BookingOperations = item.booking.operations;
  const pay = ops.payment ? 'Paid' : `${formatPhpCentavos(deskTotal(item))} due`;
  return ops.attendance === 'none' ? pay : ops.attendance === 'no_show' ? 'No-show' : `${ATTENDANCE[ops.attendance].label} · ${pay}`;
}
const entryTimes = (entry: DeskEntry) =>
  `${entry.continuesBefore ? 'Earlier' : clockText(entry.start)} – ${entry.continuesAfter ? 'next day' : clockText(entry.end)}`;

/**
 * The day's confirmed bookings on a court timeline under a week strip. Tap a booking to check
 * players in, record their payment or mark a no-show. Records open at each booking's start by
 * the server's clock and never change a booking's status, snapshot or inventory.
 */
export function FrontDesk({ actor, venueId, initialDate }: { actor: string; venueId: string; initialDate: string | null }) {
  const { transports } = useMemo(() => deskServices(actor), [actor]);
  const [deviceToday] = useState(() => toManilaDateTime(new Date()).date);
  const [date, setDate] = useState(initialDate ?? deviceToday); const [at, setAt] = useState<string | null>(null);
  const [venue, setVenue] = useState<VenueDetail | null>(null); const [paying, setPaying] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<CalendarView | null>(null); const [calendarRevision, setCalendarRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(null); const [failure, setFailure] = useState<DeskFailure | null>(null);
  const [message, setMessage] = useState<string | null>(null); const lock = useRef(false); const alive = useRef(false);
  // The sheet keeps its last booking while it fades out; `visible` opens and closes it.
  const [open, setOpen] = useState<string | null>(null); const [visible, setVisible] = useState(false);
  const { after, onDismiss } = useAfterSheetClose();
  const week = weekSpan(date);
  const day = useCallback((kind: DeskKind) => async (afterId: string | null, signal: AbortSignal) => {
    const result = await loadDay(transports, kind, venueId, date, afterId, signal);
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
  // Opening hours and the week's dots come from the court calendar; the desk still works without them.
  useFocusEffect(useCallback(() => {
    void calendarRevision;
    const abort = new AbortController();
    void liveCalendar(venueId, week.start, week.days, abort.signal).then((outcome) => { if (!abort.signal.aborted && outcome.ok) setCalendar(outcome.value); }, () => {});
    return () => abort.abort();
  }, [venueId, week.start, week.days, calendarRevision]));

  const move = (next: string) => { setPaying(null); setFailure(null); setMessage(null); setAt(null); setVisible(false); setDate(next); };
  const refresh = () => { rentals.refresh(); groups.refresh(); setCalendarRevision((v) => v + 1); };
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

  const weekView = calendar?.start_date === week.start ? calendar : null;
  const today = at ? toManilaDateTime(at).date : deviceToday;
  const bookings = [...rentals.rows, ...groups.rows];
  const entries = deskEntries(date, bookings);
  const summary = deskSummary(bookings);
  const courts = weekView ? weekView.courts.map((c) => ({ id: c.court_id, name: c.name, active: c.status === 'active' }))
    : (venue?.courts ?? []).map((c) => ({ id: c.id, name: c.name, active: true }));
  const used = new Set(entries.flatMap((entry) => entry.courtIds));
  const columns: TimelineColumn[] = [
    ...courts.filter((court) => court.active || used.has(court.id)).map((court): TimelineColumn => ({
      key: court.id, title: court.name, note: court.active ? undefined : 'Inactive', open: weekView ? courtDay(weekView, court.id, date).open : null })),
    ...[...used].filter((id) => !courts.some((court) => court.id === id)).map((id): TimelineColumn => ({ key: id, title: 'Court', open: null })),
  ];
  const courtName = (id: string) => courts.find((court) => court.id === id)?.name ?? 'Court';
  const events: TimelineEvent[] = entries.flatMap((entry) => entry.courtIds.map((courtId): TimelineEvent => ({
    key: `${entry.key}:${courtId}`, column: courtId, start: entry.start, end: entry.end, title: entryTitle(entry), detail: entryDetail(entry),
    tone: entryTone(entry), continuesBefore: entry.continuesBefore, continuesAfter: entry.continuesAfter,
    accessibilityLabel: `${courtName(courtId)}: ${entryTitle(entry)}, ${entryTimes(entry)}, ${entryDetail(entry)}`,
    onPress: () => { setPaying(null); setFailure(null); setMessage(null); setOpen(entry.key); setVisible(true); },
  })));
  const range = timelineRange([...columns.flatMap((column) => column.open ?? []), ...entries], { start: 480, end: 1200 });
  const entry = entries.find((e) => e.key === open) ?? null;
  const loading = (!rentals.loaded || !groups.loaded) && (rentals.busy || groups.busy);

  const panel = (item: DeskBooking) => {
    const ops = item.booking.operations; const started = at !== null && at >= deskStart(item);
    const can = availableOperations(ops, started); const working = busy === item.booking.id; const total = formatPhpCentavos(deskTotal(item));
    return <View key={item.booking.id} style={styles.panel}>
      {item.kind === 'group' && <>
        <Text style={screenText.label}>{item.booking.source === 'walk_in' ? 'Walk-in' : 'Player group'} · {item.booking.spots} {item.booking.spots === 1 ? 'person' : 'people'}</Text>
        <Text style={screenText.body}>{item.booking.participants.join(', ')}</Text>
      </>}
      <View style={styles.badges}>
        <StatusBadge label={ATTENDANCE[ops.attendance].label} tone={ATTENDANCE[ops.attendance].tone} />
        <StatusBadge label={ops.payment ? `Paid ${formatPhpCentavos(ops.payment.amount_centavos)} · ${PAYMENT_METHOD_LABELS[ops.payment.method]}` : `${total} due`}
          tone={ops.payment ? 'success' : 'pending'} />
      </View>
      <Text style={styles.caption}>Ref {shortReference(item.booking.id)}{ops.attendance_at ? ` · ${ATTENDANCE[ops.attendance].label} at ${clockText(minutesFrom(date, ops.attendance_at))}` : ''}</Text>
      {!started && ops.attendance === 'none' && <Text style={styles.caption}>Check-in, no-shows and payments open at the start time.</Text>}
      {(can.checkIn || can.complete || (can.pay && paying !== item.booking.id) || can.noShow) && <View style={styles.actions}>
        {can.checkIn && <Button label="Check in" loading={working} disabled={Boolean(busy)} style={styles.grow}
          onPress={() => void run(item, { kind: 'check_in', booking_id: item.booking.id }, 'Checked in.')} />}
        {can.complete && <Button label="Mark completed" loading={working} disabled={Boolean(busy)} style={styles.grow}
          onPress={() => void run(item, { kind: 'complete', booking_id: item.booking.id }, 'Marked completed.')} />}
        {can.pay && paying !== item.booking.id && <Button label={`Record ${total}`} variant="accent" disabled={Boolean(busy)} style={styles.grow}
          accessibilityLabel={`Record ${total} payment`} onPress={() => setPaying(item.booking.id)} />}
        {can.noShow && <Button label="No-show" variant="secondary" disabled={Boolean(busy)} style={styles.grow} onPress={() => confirmNoShow(item)} />}
      </View>}
      {can.pay && paying === item.booking.id && <View style={styles.methods}>
        <Text style={screenText.label}>How did they pay {total}?</Text>
        <View style={styles.choices}>
          {ARRIVAL_PAYMENT_METHODS.map((method) => <Choice key={method} label={PAYMENT_METHOD_LABELS[method]} selected={false}
            disabled={Boolean(busy)} onPress={() => confirmPayment(item, method)} />)}
        </View>
        <Button label="Not now" variant="secondary" onPress={() => setPaying(null)} />
      </View>}
    </View>;
  };

  return <OwnerScreen>
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={screenText.title}>{venue?.name ?? weekView?.name ?? 'Front desk'}</Text>
      <Text style={styles.caption}>Confirmed bookings by start time, in Philippine time. Tap one to check in, take payment or mark a no-show.</Text>
    </View>
    <View style={styles.toolbar}>
      <IconPill icon="plus" label="Outside booking" tone="accent" accessibilityLabel="Record an outside booking"
        onPress={() => router.push({ pathname: '/owner/entry/[id]', params: { id: venueId } })} />
      <IconPill icon="refresh" label="Refresh" accessibilityLabel="Refresh bookings" loading={rentals.busy || groups.busy} onPress={refresh} />
    </View>
    <DateStrip value={date} today={today} onChange={move} marks={weekView ? calendarMarks(weekView) : undefined}
      markLabels={{ busy: 'has bookings', attention: 'has a request on hold' }} />
    <View style={styles.stats} accessible accessibilityLabel={`${summary.bookings} bookings, ${summary.arrived} arrived, ${formatPhpCentavos(summary.paidCentavos)} collected, ${formatPhpCentavos(summary.dueCentavos)} due`}>
      <Stat value={String(summary.bookings)} label={summary.bookings === 1 ? 'Booking' : 'Bookings'} />
      <Stat value={String(summary.arrived)} label="Arrived" />
      <Stat value={formatPhpCentavos(summary.paidCentavos)} label="Collected" />
      <Stat value={formatPhpCentavos(summary.dueCentavos)} label="Due" />
    </View>
    {!visible && failure && <Notice text={deskFailureMessage(failure)} tone="error" />}
    {!visible && message && <Notice text={message} tone="success" />}
    {[rentals, groups].map((pages, index) => pages.failure && <View key={index} style={styles.retry}>
      <Notice text={deskFailureMessage(pages.failure)} tone="error" />
      <Button label={`Retry ${index === 0 ? 'rentals' : 'open play'}`} variant="secondary" onPress={pages.refresh} />
    </View>)}
    {loading && <View style={styles.row} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.primary} accessible={false} /><Text style={screenText.body}>Loading bookings…</Text>
    </View>}
    {rentals.loaded && groups.loaded && entries.length === 0 && <Notice text={`No confirmed bookings start on ${shortDateText(date)}.`} />}
    {columns.length > 0 && <>
      <TimelineLegend items={LEGEND} />
      <DayTimeline columns={columns} events={events} range={range} now={date === today && at ? minutesFrom(date, at) : null} />
    </>}
    {(rentals.cursor || groups.cursor) && <>
      <Text style={styles.caption}>Totals cover the bookings loaded so far.</Text>
      <Button label="Load more bookings" variant="secondary" disabled={rentals.busy || groups.busy} onPress={() => { rentals.more(); groups.more(); }} />
    </>}
    <Text style={styles.caption}>Attendance and payments are records only: they never change a booking’s status or saved total, and pickly collects no money here.</Text>

    <Sheet visible={visible} onClose={() => setVisible(false)} onDismiss={onDismiss} title={entry ? entryTitle(entry) : 'Booking'}
      subtitle={entry ? `${entryTimes(entry)} · ${entry.courtIds.map(courtName).join(', ')}` : undefined}>
      {failure && <Notice text={deskFailureMessage(failure)} tone="error" />}
      {message && <Notice text={message} tone="success" />}
      {entry ? entry.items.map(panel) : <Text style={screenText.body}>This booking is no longer on this day’s list. Refresh to check it.</Text>}
      {entry?.kind === 'session' && <Button label="Open-play sessions" variant="secondary"
        onPress={() => { setVisible(false); after(() => router.push({ pathname: '/owner/sessions/[id]', params: { id: venueId } })); }} />}
    </Sheet>
  </OwnerScreen>;
}

function Stat({ value, label }: { value: string; label: string }) {
  return <View style={styles.stat}>
    <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{value}</Text>
    <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
  </View>;
}

const styles = StyleSheet.create({
  heading: { gap: 4 },
  caption: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  retry: { gap: 8 },
  stats: { flexDirection: 'row', backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, paddingVertical: 12, paddingHorizontal: 6 },
  stat: { flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: 4 },
  statValue: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 17, lineHeight: 23 },
  statLabel: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 12, lineHeight: 16 },
  panel: { gap: 10, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  grow: { flexGrow: 1 },
  methods: { gap: 10 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
