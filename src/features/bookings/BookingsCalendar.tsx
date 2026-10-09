import { formatPhpCentavos, type RentalBooking, type SessionBooking } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { AgendaRow } from '@/components/calendar/AgendaRow';
import { DateStrip } from '@/components/calendar/DateStrip';
import { clockText, manilaParts, monthDayText, shortDateText } from '@/components/calendar/dates';
import { PicklyMascot } from '@/components/mascot/PicklyMascot';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconPill } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { screenText } from '@/components/ui/Screen';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { loadGroupHistory } from '@/features/openPlay/client';
import { groupStatus } from '@/features/openPlay/model';
import { GroupRecovery, useGroupAttempt } from '@/features/openPlay/Recovery';
import { GroupError } from '@/features/openPlay/ui';
import { usePages } from '@/features/openPlay/usePages';
import { loadHistory } from '@/features/rental/client';
import { bookingStatus, mergeHistory } from '@/features/rental/model';
import { Recovery, useAttempt } from '@/features/rental/Recovery';
import { RentalError } from '@/features/rental/ui';
import { useRetryWait } from '@/features/rental/useRetryWait';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { isLive, playerEntries, playerMarks, upcoming, type PlayerEntry } from './agenda';

// History pages stop loading here; the list views ask for a refresh instead (as in RentalHistory).
const MAX_ROWS = 200;

/**
 * The Bookings tab's calendar: rentals and open-play groups together on a week strip (dots on
 * booked days), the chosen day's bookings by time, and what's coming up next. Statuses come from
 * the same server history reads as the list views.
 */
export function BookingsCalendar({ actor }: { actor: string }) {
  const rentalRecovery = useAttempt(actor); const groupRecovery = useGroupAttempt(actor);
  const rentalTransport = rentalRecovery.transport; const groupTransport = groupRecovery.transport;
  const loadRentals = useCallback((after: string | null, signal: AbortSignal) => loadHistory(rentalTransport, after, signal), [rentalTransport]);
  const loadGroups = useCallback((after: string | null, signal: AbortSignal) => loadGroupHistory(groupTransport, after, signal), [groupTransport]);
  const rentals = usePages(loadRentals, mergeHistory<RentalBooking>);
  const groups = usePages(loadGroups, mergeHistory<SessionBooking>);
  const wait = Math.max(useRetryWait(rentals.failure), useRetryWait(groups.failure));
  const [today] = useState(() => manilaParts(Date.now()).date);
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(useCallback(() => { setNow(Date.now()); }, []));
  const [date, setDate] = useState(today);

  const entries = playerEntries(rentals.rows, groups.rows);
  const day = entries.filter((entry) => entry.date === date);
  const next = upcoming(entries, now, 5).filter((entry) => entry.date !== date).slice(0, 4);
  const live = upcoming(entries, now, MAX_ROWS * 2).length;
  const busy = rentals.busy || groups.busy;
  const loaded = rentals.loaded && groups.loaded;
  const failed = Boolean(rentals.failure || groups.failure);

  // Public venue details name the venue and court; each venue is fetched once while this screen lives.
  const [venues, setVenues] = useState<Record<string, VenueDetail | null>>({});
  const requested = useRef(new Set<string>()); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const neededKey = [...new Set([...day, ...next].map((entry) => entry.venueId))].sort().join(',');
  useEffect(() => {
    for (const id of neededKey ? neededKey.split(',') : []) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      void loadLiveVenueDetail(id, new AbortController().signal).then(
        (venue) => { if (mounted.current) setVenues((current) => ({ ...current, [id]: venue })); },
        () => { requested.current.delete(id); });
    }
  }, [neededKey]);

  const rentalById = new Map(rentals.rows.map((b) => [b.id, b])); const groupById = new Map(groups.rows.map((b) => [b.id, b]));
  const statusOf = (entry: PlayerEntry) => {
    const rental = rentalById.get(entry.id); const group = groupById.get(entry.id);
    return entry.kind === 'rental' && rental ? bookingStatus(rental) : group ? groupStatus(group) : { label: 'Booking', tone: 'neutral' as const };
  };
  const row = (entry: PlayerEntry, upcomingRow: boolean) => {
    const venue = venues[entry.venueId]; const status = statusOf(entry);
    const title = venue?.name ?? (entry.kind === 'rental' ? 'Court rental' : entry.title ?? 'Open play');
    const price = `${formatPhpCentavos(entry.totalCentavos)} at the venue`;
    const subtitle = entry.kind === 'rental'
      ? `${venue?.courts.find((court) => court.id === entry.courtIds[0])?.name ?? 'Court rental'} · ${entry.durationMinutes} min · ${price}`
      : `Open play: ${entry.title} · ${entry.spots} ${entry.spots === 1 ? 'person' : 'people'} · ${price}`;
    const tone = !isLive(entry) ? 'muted' : entry.status === 'pending' ? 'hold' : entry.kind === 'rental' ? 'rental' : 'session';
    if (upcomingRow) {
      return <AgendaRow key={entry.id} start={monthDayText(entry.date)} end={clockText(entry.start)} tone={tone} title={title} subtitle={subtitle}
        badge={status} accessibilityLabel={`${shortDateText(entry.date)} at ${clockText(entry.start)}: ${title}, ${status.label}. Show this day.`}
        onPress={() => setDate(entry.date)} />;
    }
    return <AgendaRow key={entry.id} start={clockText(entry.start)} end={`${clockText(entry.end)}${entry.end > 1440 ? ' +1' : ''}`} tone={tone}
      title={title} subtitle={subtitle} badge={status}
      accessibilityLabel={`${status.label}: ${title}, ${clockText(entry.start)} to ${clockText(entry.end)}. ${subtitle}. Open details.`}
      onPress={() => entry.kind === 'rental'
        ? router.push({ pathname: '/rental/booking/[id]', params: { id: entry.id } })
        : router.push({ pathname: '/play/booking/[id]', params: { id: entry.id } })} />;
  };
  const canLoadMore = (rentals.cursor && rentals.rows.length < MAX_ROWS) || (groups.cursor && groups.rows.length < MAX_ROWS);

  return <>
    <Recovery recovery={rentalRecovery} />
    <GroupRecovery recovery={groupRecovery} />
    <View style={styles.toolbar}>
      <IconPill icon="refresh" label={wait ? `Refresh in ${wait}s` : busy ? 'Checking…' : 'Refresh'} accessibilityLabel="Refresh bookings"
        loading={busy} disabled={wait > 0} onPress={() => { rentals.refresh(); groups.refresh(); }} />
      {loaded && live > 0 && <Text style={styles.count}>{live} upcoming</Text>}
    </View>
    <DateStrip value={date} today={today} onChange={setDate} marks={playerMarks(entries)}
      markLabels={{ busy: 'has bookings', attention: 'has a booking awaiting approval' }} />
    {rentals.failure && <RentalError failure={rentals.failure} />}
    {groups.failure && <GroupError failure={groups.failure} />}
    {failed && entries.length > 0 && <Text style={styles.caption}>Showing the last received records. Refresh to check current statuses.</Text>}
    {!loaded && busy && <View style={styles.row} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.primary} accessible={false} /><Text style={screenText.body}>Loading your bookings…</Text>
    </View>}
    {loaded && entries.length === 0 && !failed ? (
      <Card>
        <View style={styles.center}><PicklyMascot size={160} /></View>
        <Text style={screenText.title}>Find your next game.</Text>
        <Text style={screenText.body}>Your court rentals and open-play groups will show on this calendar. Choose a verified venue in Discover to book.</Text>
      </Card>
    ) : loaded && <>
      <Text accessibilityRole="header" style={styles.day}>{shortDateText(date)}{date === today ? ' · Today' : ''}</Text>
      {day.length === 0 && <Notice text={`Nothing booked on ${shortDateText(date)}.`} />}
      {day.map((entry) => row(entry, false))}
    </>}
    {next.length > 0 && <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.groupTitle}>Coming up</Text>
      {next.map((entry) => row(entry, true))}
    </View>}
    {canLoadMore && <Button label="Load more bookings" variant="secondary" disabled={busy || wait > 0}
      onPress={() => { if (rentals.rows.length < MAX_ROWS) rentals.more(); if (groups.rows.length < MAX_ROWS) groups.more(); }} />}
  </>;
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  count: { fontFamily: fonts.semibold, color: colors.text, fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  center: { alignItems: 'center' },
  day: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 17, lineHeight: 23, paddingHorizontal: 4 },
  section: { gap: 10 },
  groupTitle: { fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 12, lineHeight: 18, letterSpacing: 1.2, textTransform: 'uppercase', marginLeft: 6 },
});
