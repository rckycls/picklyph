import type { CalendarView } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { DateStrip } from '@/components/calendar/DateStrip';
import { DayTimeline, TimelineLegend, type TimelineColumn, type TimelineEvent } from '@/components/calendar/DayTimeline';
import { shortDateText } from '@/components/calendar/dates';
import { timelineRange } from '@/components/calendar/timeline';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconPill } from '@/components/ui/IconButton';
import { Notice } from '@/components/ui/Notice';
import { screenText } from '@/components/ui/Screen';
import { Sheet, useAfterSheetClose } from '@/components/ui/Sheet';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { calendarFailureMessage, type CalendarFailure } from './calendarClient';
import {
  blockCommand, calendarMarks, clockLabel, courtDay, endOptions, manilaDate, minuteOfDay, slotForm, spanLabel, startOptions, weekSpan,
  type AgendaItem, type CourtDay,
} from './calendarModel';
import { Choice, OptionStepper } from './FormControls';
import { liveBlockCourt, liveCalendar, liveReleaseBlock } from './liveOwner';
import { OwnerScreen } from './OwnerScreen';

type Loaded = { status: 'loading' } | { status: 'ready'; view: CalendarView } | { status: 'error'; failure: CalendarFailure | null };
type BlockForm = { courtId: string; start: number; end: number; requestId: string };
type Open = { kind: 'block'; form: BlockForm | null } | { kind: 'item'; courtId: string; item: AgendaItem } | null;

const LEGEND = [
  { tone: 'rental', label: 'Court rental' }, { tone: 'session', label: 'Open play' },
  { tone: 'hold', label: 'Request on hold' }, { tone: 'block', label: 'Blocked' },
] as const;

const itemTitle = (item: AgendaItem) => (item.heldUntil ? 'Request on hold' : item.label);
const itemTimes = (item: AgendaItem) =>
  `${item.fromPreviousDay ? 'Earlier' : clockLabel(item.start)} – ${item.toNextDay ? 'next day' : clockLabel(item.end)}`;

/**
 * A week strip over one Manila day of every court as a timeline, from one server snapshot of the
 * whole week: opening hours, rentals, open play, request holds and blocks. Tap open time to block it.
 */
export function CourtCalendar({ venueId }: { venueId: string }) {
  // The device clock only picks the first day; the server clock (`view.at`) decides "today" after loading.
  const [deviceToday] = useState(() => manilaDate(Date.now()));
  const [date, setDate] = useState(deviceToday);
  const week = weekSpan(date);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const request = useRef<AbortController | null>(null);
  const load = useCallback((start: string, days: number) => {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setLoaded((current) => (current.status === 'ready' && current.view.start_date === start && current.view.days === days ? current : { status: 'loading' }));
    void liveCalendar(venueId, start, days, abort.signal).then((outcome) => {
      if (abort.signal.aborted) return;
      setLoaded(outcome.ok ? { status: 'ready', view: outcome.value } : { status: 'error', failure: outcome.failure });
    }, () => { if (!abort.signal.aborted) setLoaded({ status: 'error', failure: null }); });
  }, [venueId]);
  // Reload on focus too, so changes made in Hours and closures or at the front desk show on return.
  useFocusEffect(useCallback(() => { load(week.start, week.days); return () => request.current?.abort(); }, [load, week.start, week.days]));
  const reload = () => load(week.start, week.days);

  const view = loaded.status === 'ready' && loaded.view.start_date === week.start ? loaded.view : null;
  const today = view ? manilaDate(view.at) : deviceToday;
  const days = useMemo(() => (view ? view.courts.map((court) => courtDay(view, court.court_id, date)) : []), [view, date]);
  const marks = useMemo(() => (view ? calendarMarks(view) : undefined), [view]);
  const blockable = days.filter((day) => day.active && startOptions(day.free).length > 0);

  // The sheet keeps its last content while it fades out; `visible` opens and closes it.
  const [open, setOpen] = useState<Open>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const { after, onDismiss } = useAfterSheetClose();
  const show = (next: Open) => { setSheetError(null); setConfirming(false); setMessage(null); setOpen(next); setVisible(true); };
  const close = () => { if (!busy) setVisible(false); };
  const go = (action: () => void) => { setVisible(false); after(action); };

  const formFor = (day: CourtDay, start?: number): BlockForm | null => {
    const span = slotForm(day.free, start ?? startOptions(day.free)[0] ?? -1);
    return span && { courtId: day.courtId, ...span, requestId: randomUUID() };
  };
  const onSlot = (courtId: string, minute: number) => {
    const day = days.find((d) => d.courtId === courtId);
    if (!day?.active || busy) return;
    const form = formFor(day, minute);
    if (form) show({ kind: 'block', form });
    else setMessage({ text: `${clockLabel(minute)} on ${day.name} isn’t free to block. Choose open time that hasn’t started yet.`, tone: 'error' });
  };
  const block = async () => {
    if (open?.kind !== 'block' || !open.form || busy) return;
    const form = open.form; const name = days.find((d) => d.courtId === form.courtId)?.name ?? 'the court';
    setBusy(true); setSheetError(null);
    const outcome = await liveBlockCourt(blockCommand(form.courtId, date, form, form.requestId));
    setBusy(false);
    if (outcome.ok) { setVisible(false); setMessage({ text: `Blocked ${name}, ${spanLabel(form)}.`, tone: 'success' }); reload(); return; }
    setSheetError(calendarFailureMessage(outcome.failure));
    // A definitive refusal needs a fresh request; after an uncertain reply the same ID retries safely.
    if (outcome.failure.kind === 'rejected') {
      setOpen((current) => (current?.kind === 'block' && current.form?.requestId === form.requestId
        ? { kind: 'block', form: { ...current.form, requestId: randomUUID() } } : current));
      reload();
    }
  };
  const release = async (item: AgendaItem) => {
    if (busy) return;
    setBusy(true); setSheetError(null);
    const outcome = await liveReleaseBlock(item.id);
    setBusy(false); setConfirming(false);
    if (outcome.ok) { setVisible(false); setMessage({ text: `Released ${spanLabel(item)}. Players can book it again.`, tone: 'success' }); reload(); }
    else setSheetError(calendarFailureMessage(outcome.failure));
  };

  const columns: TimelineColumn[] = days.map((day) => ({
    key: day.courtId, title: day.name, open: day.open, disabled: !day.active,
    note: !day.active ? 'Inactive' : day.closedReason === 'closure' ? 'Closed' : day.closedReason === 'no_hours' ? 'No hours' : undefined,
  }));
  const events: TimelineEvent[] = days.flatMap((day) => day.items.map((item): TimelineEvent => ({
    key: item.id, column: day.courtId, start: item.start, end: item.end, title: itemTitle(item), detail: itemTimes(item),
    tone: item.kind === 'block' ? 'block' : item.heldUntil ? 'hold' : item.kind === 'rental' ? 'rental' : 'session',
    continuesBefore: item.fromPreviousDay, continuesAfter: item.toNextDay,
    accessibilityLabel: `${day.name}: ${itemTitle(item)}, ${itemTimes(item)}${item.heldUntil ? `, held until ${item.heldUntil}` : ''}`,
    onPress: () => show({ kind: 'item', courtId: day.courtId, item }),
  })));
  const range = timelineRange([...days.flatMap((day) => day.open), ...days.flatMap((day) => day.items)], { start: 360, end: 1320 });
  const booked = events.filter((event) => event.tone !== 'block').length;
  const blocks = events.length - booked;
  const form = open?.kind === 'block' ? open.form : null;
  const formDay = form ? days.find((day) => day.courtId === form.courtId) ?? null : null;
  const item = open?.kind === 'item' ? open : null;
  const itemCourt = item ? days.find((day) => day.courtId === item.courtId)?.name ?? 'Court' : '';

  return (
    <OwnerScreen>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={screenText.title}>{view?.name ?? 'Court calendar'}</Text>
        <Text style={styles.caption}>Philippine time. Tap open time on a court to block it.</Text>
      </View>
      <View style={styles.toolbar}>
        <IconPill icon="lock" label="Block time" tone="accent" disabled={!view || blockable.length === 0 || busy}
          onPress={() => show({ kind: 'block', form: blockable.length === 1 ? formFor(blockable[0]!) : null })} />
        <IconPill icon="clock" label="Hours & closures" accessibilityLabel="Hours and closures"
          onPress={() => router.push({ pathname: '/owner/hours/[id]', params: { id: venueId } })} />
        <IconPill icon="refresh" label="Refresh" accessibilityLabel="Refresh the calendar" loading={loaded.status === 'loading'} onPress={reload} />
      </View>
      <DateStrip value={date} today={today} marks={marks} markLabels={{ busy: 'has bookings', attention: 'has a request on hold' }}
        onChange={(next) => { setMessage(null); setVisible(false); setDate(next); }} />
      {message && <Notice text={message.text} tone={message.tone} />}
      {!view && loaded.status !== 'error' && (
        <View style={styles.row} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.primary} accessible={false} />
          <Text style={screenText.body}>Loading the calendar…</Text>
        </View>
      )}
      {loaded.status === 'error' && (
        <Card>
          <Text accessibilityRole="alert" style={screenText.body}>{loaded.failure ? calendarFailureMessage(loaded.failure) : 'Couldn’t load the calendar.'}</Text>
          <Button label="Try again" variant="secondary" onPress={reload} />
        </Card>
      )}
      {view && view.schedule_revision === null && (
        <Card>
          <Text style={screenText.body}>Set this venue’s opening hours and rates before blocking time. Courts can’t be blocked or booked outside opening hours.</Text>
          <Button label="Set hours and rates" onPress={() => router.push({ pathname: '/owner/hours/[id]', params: { id: venueId } })} />
        </Card>
      )}
      {view && view.courts.length === 0 && <Card><Text style={screenText.body}>This venue has no courts yet. Add one from Edit venue.</Text></Card>}
      {view && columns.length > 0 && <>
        <View style={styles.summary}>
          <Text style={styles.day} accessibilityRole="header">{shortDateText(date)}{date === today ? ' · Today' : ''}</Text>
          <Text style={styles.caption}>{booked === 0 && blocks === 0 ? 'Nothing booked or blocked'
            : [booked && `${booked} ${booked === 1 ? 'booking' : 'bookings'}`, blocks && `${blocks} ${blocks === 1 ? 'block' : 'blocks'}`].filter(Boolean).join(' · ')}</Text>
        </View>
        <TimelineLegend items={LEGEND} />
        <DayTimeline columns={columns} events={events} range={range} now={date === today ? minuteOfDay(date, view.at) : null}
          onSlotPress={onSlot} selection={visible && form && formDay ? { column: form.courtId, start: form.start, end: form.end, label: 'New block' } : null} />
      </>}

      <Sheet visible={visible && open?.kind === 'block'} onClose={close} onDismiss={onDismiss} title={formDay ? `Block ${formDay.name}` : 'Block time'}
        subtitle={`${shortDateText(date)} · Players can’t book blocked time.`}>
        {!form && <>
          <Text style={screenText.label}>Which court?</Text>
          <View style={styles.choices}>
            {blockable.map((day) => <Choice key={day.courtId} label={day.name} selected={false} disabled={busy}
              onPress={() => setOpen({ kind: 'block', form: formFor(day) })} />)}
          </View>
        </>}
        {form && formDay && (startOptions(formDay.free).includes(form.start) ? <>
          <OptionStepper label="Starts" options={startOptions(formDay.free)} value={form.start} format={clockLabel} disabled={busy}
            onChange={(start) => {
              const ends = endOptions(formDay.free, start);
              setOpen({ kind: 'block', form: { ...form, start, end: ends.includes(form.end) ? form.end : ends[0]! } });
            }} />
          <OptionStepper label="Ends" options={endOptions(formDay.free, form.start)} value={form.end} format={clockLabel} disabled={busy}
            onChange={(end) => setOpen({ kind: 'block', form: { ...form, end } })} />
        </> : <>
          <Text style={screenText.body}>That time isn’t free any more.</Text>
          <Button label="Choose the first free time" variant="secondary" disabled={busy || !formFor(formDay)}
            onPress={() => setOpen({ kind: 'block', form: formFor(formDay) })} />
        </>)}
        {sheetError && <Notice text={sheetError} tone="error" />}
        {form && <Button label={`Block ${spanLabel(form)}`} loading={busy} disabled={busy || !formDay || !startOptions(formDay.free).includes(form.start)}
          onPress={() => void block()} />}
        <Button label="Cancel" variant="secondary" disabled={busy} onPress={close} />
      </Sheet>

      <Sheet visible={visible && item !== null} onClose={close} onDismiss={onDismiss} title={item ? itemTitle(item.item) : ''}
        subtitle={item ? `${itemCourt} · ${shortDateText(date)} · ${itemTimes(item.item)}` : undefined}>
        {item?.item.kind === 'block' && <>
          <Text style={screenText.body}>Players can’t book this time. Release it to open the court again.</Text>
          {sheetError && <Notice text={sheetError} tone="error" />}
          {confirming ? <>
            <Text style={screenText.label}>Release this block? Players will be able to book this time.</Text>
            <View style={styles.pair}>
              <Button label="Release" loading={busy} disabled={busy} onPress={() => void release(item.item)} style={styles.grow} />
              <Button label="Keep" variant="secondary" disabled={busy} onPress={() => setConfirming(false)} style={styles.grow} />
            </View>
          </> : <Button label="Release block" variant="secondary" onPress={() => setConfirming(true)} />}
        </>}
        {item && item.item.kind !== 'block' && <>
          {item.item.heldUntil
            ? <Text style={screenText.body}>A player’s request holds this time until {item.item.heldUntil}. Accept or decline it before then.</Text>
            : <Text style={screenText.body}>{item.item.kind === 'rental' ? 'A confirmed court rental.' : 'An open-play session on this court.'} Check-ins and payments are on the front desk.</Text>}
          {item.item.heldUntil
            ? <Button label="Open booking requests" onPress={() => go(() => router.push({ pathname: '/owner/requests/[id]', params: { id: venueId } }))} />
            : <Button label="Open the front desk" onPress={() => go(() => router.push({ pathname: '/owner/desk/[id]', params: { id: venueId, date } }))} />}
          {item.item.kind === 'session' && <Button label="Open-play sessions" variant="secondary"
            onPress={() => go(() => router.push({ pathname: '/owner/sessions/[id]', params: { id: venueId } }))} />}
          <Text style={styles.caption}>Bookings change from the booking itself, not the calendar.</Text>
        </>}
      </Sheet>
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  heading: { gap: 4 },
  caption: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  summary: { gap: 2, paddingHorizontal: 4 },
  day: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 17, lineHeight: 23 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pair: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  grow: { flexGrow: 1 },
});
