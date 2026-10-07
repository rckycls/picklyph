import type { CalendarView } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { calendarFailureMessage, type CalendarFailure } from './calendarClient';
import {
  addDays, blockCommand, clockLabel, courtDay, dayTitle, endOptions, manilaDate, spanLabel, startOptions,
  type AgendaItem, type CourtDay,
} from './calendarModel';
import { OptionStepper } from './FormControls';
import { liveBlockCourt, liveCalendar, liveReleaseBlock } from './liveOwner';
import { OwnerScreen } from './OwnerScreen';

type Loaded = { status: 'loading' } | { status: 'ready'; view: CalendarView } | { status: 'error'; failure: CalendarFailure | null };

/** One Manila day of every court: opening hours, blocks, bookings and holds from one server snapshot. */
export function CourtCalendar({ venueId }: { venueId: string }) {
  // The device clock only picks the first day; the server clock (`view.at`) decides "today" after loading.
  const [deviceToday] = useState(() => manilaDate(Date.now()));
  const [date, setDate] = useState(deviceToday);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const request = useRef<AbortController | null>(null);
  const load = useCallback((day: string) => {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setLoaded((current) => (current.status === 'ready' && current.view.start_date === day ? current : { status: 'loading' }));
    void liveCalendar(venueId, day, 1, abort.signal).then((outcome) => {
      if (abort.signal.aborted) return;
      setLoaded(outcome.ok ? { status: 'ready', view: outcome.value } : { status: 'error', failure: outcome.failure });
    }, () => { if (!abort.signal.aborted) setLoaded({ status: 'error', failure: null }); });
  }, [venueId]);
  // Reload on focus too, so changes made in Hours and closures show on return.
  useFocusEffect(useCallback(() => { load(date); return () => request.current?.abort(); }, [load, date]));

  const view = loaded.status === 'ready' && loaded.view.start_date === date ? loaded.view : null;
  const today = view ? manilaDate(view.at) : deviceToday;
  return (
    <OwnerScreen>
      <Card>
        {view && <Text accessibilityRole="header" style={screenText.title}>{view.name}</Text>}
        <Text style={styles.day} accessibilityLiveRegion="polite">{dayTitle(date)}{date === today ? ' · Today' : ''}</Text>
        <Text style={screenText.body}>All times are Philippine time. Blocks hold a court for outside bookings, maintenance or walk-ins.</Text>
        <View style={styles.row}>
          <Button label="Previous day" variant="secondary" disabled={date <= '2000-01-01'} onPress={() => setDate(addDays(date, -1))} style={styles.grow} />
          <Button label="Next day" variant="secondary" disabled={date >= '2099-12-31'} onPress={() => setDate(addDays(date, 1))} style={styles.grow} />
        </View>
        {date !== today && <Button label="Back to today" variant="secondary" onPress={() => setDate(today)} />}
        <Button label="Hours and closures" variant="secondary" onPress={() => router.push({ pathname: '/owner/hours/[id]', params: { id: venueId } })} />
      </Card>
      {!view && loaded.status !== 'error' && (
        <View style={styles.row} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.primary} accessible={false} />
          <Text style={screenText.body}>Loading the calendar…</Text>
        </View>
      )}
      {loaded.status === 'error' && (
        <Card>
          <Text accessibilityRole="alert" style={screenText.body}>{loaded.failure ? calendarFailureMessage(loaded.failure) : 'Couldn’t load the calendar.'}</Text>
          <Button label="Try again" variant="secondary" onPress={() => load(date)} />
        </Card>
      )}
      {view && view.schedule_revision === null && (
        <Card>
          <Text style={screenText.body}>Set this venue’s opening hours and rates before blocking time. Courts can’t be blocked or booked outside opening hours.</Text>
        </Card>
      )}
      {view && view.courts.length === 0 && <Card><Text style={screenText.body}>This venue has no courts yet. Add one from Edit venue.</Text></Card>}
      {view && view.courts.map((court) => (
        <CourtDayCard key={`${court.court_id}-${date}`} day={courtDay(view, court.court_id, date)} date={date} onChanged={() => load(date)} />
      ))}
    </OwnerScreen>
  );
}

function CourtDayCard({ day, date, onChanged }: { day: CourtDay; date: string; onChanged: () => void }) {
  const [form, setForm] = useState<{ start: number; end: number; requestId: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const starts = startOptions(day.free);
  const openForm = () => {
    // Default to the first free hour (or half hour).
    const start = starts[0]!; const ends = endOptions(day.free, start);
    setMessage(null); setForm({ start, end: ends[Math.min(1, ends.length - 1)]!, requestId: randomUUID() });
  };
  const block = async () => {
    if (!form || busy) return;
    setBusy(true); setMessage(null);
    const outcome = await liveBlockCourt(blockCommand(day.courtId, date, form, form.requestId));
    setBusy(false);
    if (outcome.ok) { setForm(null); setMessage(`Blocked ${spanLabel(form)}.`); onChanged(); return; }
    setMessage(calendarFailureMessage(outcome.failure));
    // A definitive refusal needs a fresh request; after an uncertain reply the same ID retries safely.
    if (outcome.failure.kind === 'rejected') { setForm({ ...form, requestId: randomUUID() }); onChanged(); }
  };
  const release = async (item: AgendaItem) => {
    if (busy) return;
    setBusy(true); setMessage(null);
    const outcome = await liveReleaseBlock(item.id);
    setBusy(false); setConfirming(null);
    if (outcome.ok) { setMessage(`Released ${spanLabel(item)}. Players can book it again.`); onChanged(); }
    else setMessage(calendarFailureMessage(outcome.failure));
  };
  return (
    <Card>
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={styles.court}>{day.name}</Text>
        <StatusBadge label={day.active ? 'Active' : 'Inactive'} tone={day.active ? 'success' : 'neutral'} />
      </View>
      <Text style={screenText.body}>
        {day.closedReason === 'closure' ? 'Closed all day (court closure).'
          : day.closedReason === 'no_hours' ? 'No opening hours this day.'
            : `Open ${day.open.map(spanLabel).join(', ')}`}
      </Text>
      {day.items.length === 0 && day.open.length > 0 && <Text style={screenText.body}>Nothing booked or blocked.</Text>}
      {day.items.map((item) => (
        <View key={item.id} style={styles.item}>
          <Text style={screenText.label}>
            {item.fromPreviousDay ? 'From the previous day' : clockLabel(item.start)} – {item.toNextDay ? 'into the next day' : clockLabel(item.end)} · {item.label}
          </Text>
          {item.heldUntil && <Text style={screenText.body}>Held for a pending request until {item.heldUntil}.</Text>}
          {item.releasable && confirming !== item.id && (
            <Button label="Release block" variant="secondary" disabled={busy} accessibilityLabel={`Release block ${spanLabel(item)}`} onPress={() => setConfirming(item.id)} />
          )}
          {confirming === item.id && <>
            <Text style={screenText.body}>Release this block? Players will be able to book this time.</Text>
            <View style={styles.row}>
              <Button label="Release" loading={busy} disabled={busy} onPress={() => void release(item)} style={styles.grow} />
              <Button label="Keep" variant="secondary" disabled={busy} onPress={() => setConfirming(null)} style={styles.grow} />
            </View>
          </>}
        </View>
      ))}
      {day.active && !form && starts.length > 0 && <Button label="Block time" variant="secondary" disabled={busy} accessibilityLabel={`Block time on ${day.name}`} onPress={openForm} />}
      {day.active && !form && starts.length === 0 && day.open.length > 0 && <Text style={screenText.body}>No free time left to block on this day.</Text>}
      {form && <View style={styles.form}>
        <OptionStepper label="Starts" options={starts} value={form.start} format={clockLabel} disabled={busy}
          onChange={(start) => { const ends = endOptions(day.free, start); setForm({ ...form, start, end: ends.includes(form.end) ? form.end : ends[0]! }); }} />
        <OptionStepper label="Ends" options={endOptions(day.free, form.start)} value={form.end} format={clockLabel} disabled={busy}
          onChange={(end) => setForm({ ...form, end })} />
        <View style={styles.row}>
          <Button label="Block this time" loading={busy} disabled={busy} onPress={() => void block()} style={styles.grow} />
          <Button label="Cancel" variant="secondary" disabled={busy} onPress={() => { setForm(null); setMessage(null); }} style={styles.grow} />
        </View>
      </View>}
      {message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  day: { fontFamily: fonts.semibold, color: colors.text, fontSize: 17, lineHeight: 24 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  grow: { flexGrow: 1 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  court: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 19, lineHeight: 25 },
  item: { gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border },
  form: { gap: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
});
