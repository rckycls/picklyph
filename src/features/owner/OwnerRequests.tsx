import { formatPhpCentavos, toManilaDateTime } from '@picklyph/domain';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { AgendaRow } from '@/components/calendar/AgendaRow';
import { DateStrip, type DayMark } from '@/components/calendar/DateStrip';
import { clockText, manilaParts, shortDateText } from '@/components/calendar/dates';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconPill } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { screenText } from '@/components/ui/Screen';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';
import { usePages } from '../openPlay/usePages';
import { decide, deskEnd, deskFailureMessage, deskStart, deskTotal, loadRequests, mergeDesk, shortReference,
  type DeskBooking, type DeskFailure, type DeskPage, type DeskReason } from './deskClient';
import { deskServices } from './deskLive';
import { OwnerScreen } from './OwnerScreen';

const holdEnd = (item: DeskBooking) => (item.kind === 'rental' ? item.booking.allocation.expires_at : item.booking.expires_at);
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/**
 * Pending rental and open-play requests on a calendar: dots mark days with requests, the chosen
 * day lists them by start time, and other days are one tap away. Holds expire on the server;
 * nothing here changes status locally.
 */
export function OwnerRequests({ actor, venueId }: { actor: string; venueId: string }) {
  const { transports } = useMemo(() => deskServices(actor), [actor]);
  const [venue, setVenue] = useState<VenueDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null); const [failure, setFailure] = useState<DeskFailure | null>(null);
  const [message, setMessage] = useState<string | null>(null); const lock = useRef(false); const alive = useRef(false);
  const [deviceToday] = useState(() => toManilaDateTime(new Date()).date);
  const [chosen, setChosen] = useState<string | null>(null);
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

  const requests = [...rentals.rows, ...groups.rows].sort((a, b) => deskStart(a).localeCompare(deskStart(b)) || a.booking.id.localeCompare(b.booking.id));
  const byDate = new Map<string, DeskBooking[]>();
  for (const item of requests) {
    const day = manilaParts(deskStart(item)).date;
    byDate.set(day, [...(byDate.get(day) ?? []), item]);
  }
  const marks = new Map<string, DayMark>([...byDate.keys()].map((day) => [day, 'attention']));
  // Until the owner picks a day, open the earliest day with a request.
  const date = chosen ?? requests.map((item) => manilaParts(deskStart(item)).date)[0] ?? deviceToday;
  const dayRequests = byDate.get(date) ?? [];
  const otherDays = [...byDate.entries()].filter(([day]) => day !== date);
  const loaded = rentals.loaded && groups.loaded;

  const row = (item: DeskBooking) => {
    const start = manilaParts(deskStart(item)); const end = manilaParts(deskEnd(item)); const hold = holdEnd(item);
    const title = item.kind === 'rental' ? `${courtName(item.booking.allocation.court_id)} · Court rental` : item.booking.snapshot.title;
    const who = item.kind === 'group' ? `${item.booking.spots} ${item.booking.spots === 1 ? 'person' : 'people'}: ${item.booking.participants.join(', ')}\n` : '';
    const subtitle = `${who}${formatPhpCentavos(deskTotal(item))} due at the venue · Ref ${shortReference(item.booking.id)}`
      + (hold ? `\nHold ends ${clockText(manilaParts(hold).minute)}${manilaParts(hold).date !== date ? `, ${shortDateText(manilaParts(hold).date)}` : ''}; it expires unless you accept first.` : '');
    return (
      <AgendaRow key={item.booking.id} start={clockText(start.minute)} end={`${clockText(end.minute)}${end.date !== start.date ? ' +1' : ''}`} tone="hold"
        badge={{ label: 'Awaiting your decision', tone: 'pending' }} title={title} subtitle={subtitle}>
        <Button label="Accept" loading={busy === item.booking.id} disabled={Boolean(busy)} style={styles.grow}
          accessibilityLabel={`Accept ${title} at ${clockText(start.minute)}`} onPress={() => void act(item, 'accept')} />
        <Button label="Decline" variant="secondary" disabled={Boolean(busy)} style={styles.grow}
          accessibilityLabel={`Decline ${title} at ${clockText(start.minute)}`} onPress={() => confirmDecline(item)} />
      </AgendaRow>
    );
  };

  return <OwnerScreen>
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={screenText.title}>{venue?.name ?? 'Booking requests'}</Text>
      <Text style={styles.caption}>Requests hold the court or spots for up to 2 hours, capped at the start time. Accepting confirms the booking; payment stays due at the venue.</Text>
    </View>
    <View style={styles.toolbar}>
      <IconPill icon="refresh" label={rentals.busy || groups.busy ? 'Checking…' : 'Refresh'} accessibilityLabel="Refresh requests"
        loading={rentals.busy || groups.busy} onPress={() => { rentals.refresh(); groups.refresh(); }} />
      {loaded && <View style={styles.count}><Icon name="inbox" color={colors.pending} size={18} />
        <Text style={styles.countText}>{requests.length === 0 ? 'No pending requests' : `${plural(requests.length, 'request')} pending`}</Text></View>}
    </View>
    <DateStrip value={date} today={deviceToday} marks={marks} markLabels={{ attention: 'has pending requests' }}
      onChange={(next) => { setMessage(null); setFailure(null); setChosen(next); }} />
    {failure && <Notice text={deskFailureMessage(failure)} tone="error" />}
    {message && <Notice text={message} tone="success" />}
    {[rentals, groups].map((pages, index) => pages.failure && <View key={index} style={styles.retry}>
      <Notice text={deskFailureMessage(pages.failure)} tone="error" />
      <Button label={`Retry ${index === 0 ? 'rental' : 'open-play'} requests`} variant="secondary" onPress={pages.refresh} />
    </View>)}
    {!loaded && (rentals.busy || groups.busy) && <View style={styles.row} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.primary} accessible={false} /><Text style={screenText.body}>Loading requests…</Text>
    </View>}
    {loaded && <Text accessibilityRole="header" style={styles.day}>{shortDateText(date)}{date === deviceToday ? ' · Today' : ''}</Text>}
    {loaded && dayRequests.length === 0 && <Notice text={requests.length === 0
      ? 'No requests are waiting. New player requests show here and on the calendar dots above.'
      : `No requests start on ${shortDateText(date)}.`} />}
    {dayRequests.map(row)}
    {otherDays.length > 0 && <View style={styles.others}>
      <Text accessibilityRole="header" style={styles.groupTitle}>Other days with requests</Text>
      <View style={styles.list}>
        {otherDays.map(([day, items], index) => (
          <Pressable key={day} accessibilityRole="button" accessibilityLabel={`${shortDateText(day)}, ${plural(items.length, 'request')}`}
            onPress={() => { setMessage(null); setFailure(null); setChosen(day); }}
            style={({ pressed }) => [styles.other, index > 0 && styles.separator, pressed && styles.pressed]}>
            <Text style={styles.otherDate}>{shortDateText(day)}</Text>
            <Text style={styles.otherCount}>{plural(items.length, 'request')}</Text>
            <Icon name="chevronRight" color={colors.textSecondary} size={18} />
          </Pressable>
        ))}
      </View>
    </View>}
    {(rentals.cursor || groups.cursor) && <Button label="Load more requests" variant="secondary" disabled={rentals.busy || groups.busy}
      onPress={() => { rentals.more(); groups.more(); }} />}
  </OwnerScreen>;
}

const styles = StyleSheet.create({
  heading: { gap: 4 },
  caption: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  count: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  countText: { fontFamily: fonts.semibold, color: colors.text, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  retry: { gap: 8 },
  day: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 17, lineHeight: 23, paddingHorizontal: 4 },
  grow: { flexGrow: 1 },
  others: { gap: 10 },
  groupTitle: { fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 12, lineHeight: 18, letterSpacing: 1.2, textTransform: 'uppercase', marginLeft: 6 },
  list: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, overflow: 'hidden' },
  other: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16, paddingVertical: 10 },
  separator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  otherDate: { flex: 1, fontFamily: fonts.semibold, color: colors.text, fontSize: 15, lineHeight: 21 },
  otherCount: { fontFamily: fonts.medium, color: colors.pending, fontSize: 13, lineHeight: 19 },
  pressed: { backgroundColor: colors.background },
});
