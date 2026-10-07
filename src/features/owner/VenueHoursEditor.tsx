import type { CalendarCourt, ScheduleView } from '@picklyph/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { calendarFailureMessage, type CalendarFailure } from './calendarClient';
import { clockLabel, dayTitle, manilaDate } from './calendarModel';
import { CourtHoursForm } from './CourtHoursForm';
import { OptionStepper } from './FormControls';
import {
  DAY_NAMES, HoursDraftError, addBand, closureDateOptions, copyDayToAll, scheduleDraftFrom, scheduleFromDraft, toggleClosure,
  type BandDraft, type ScheduleDraft,
} from './hoursDraft';
import { liveCalendar, liveSaveVenueSchedule, liveVenueSchedule } from './liveOwner';
import { OwnerScreen } from './OwnerScreen';

type Loaded = { status: 'loading' } | { status: 'ready'; schedule: ScheduleView; courts: CalendarCourt[]; today: string }
  | { status: 'error'; failure: CalendarFailure | null };
const STARTS = Array.from({ length: 48 }, (_, i) => i * 30);
// A later stretch may continue an overnight period, so it can start after midnight.
const LATER_STARTS = Array.from({ length: 96 }, (_, i) => i * 30);

/** Venue-wide weekly hours and rates, venue closures, then per-court hours. */
export function VenueHoursEditor({ venueId }: { venueId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [closureDate, setClosureDate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; conflict: boolean } | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setLoaded({ status: 'loading' }); setMessage(null);
    const today = manilaDate(Date.now());
    void Promise.all([liveVenueSchedule(venueId, today, abort.signal), liveCalendar(venueId, today, 1, abort.signal)]).then(([schedule, calendar]) => {
      if (abort.signal.aborted) return;
      if (!schedule.ok) { setLoaded({ status: 'error', failure: schedule.failure }); return; }
      if (!calendar.ok) { setLoaded({ status: 'error', failure: calendar.failure }); return; }
      const serverToday = manilaDate(calendar.value.at);
      setDraft(scheduleDraftFrom(schedule.value.schedule)); setClosureDate(serverToday);
      setLoaded({ status: 'ready', schedule: schedule.value, courts: calendar.value.courts, today: serverToday });
    }, () => { if (!abort.signal.aborted) setLoaded({ status: 'error', failure: null }); });
  }, [venueId]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) load(); });
    return () => { active = false; request.current?.abort(); };
  }, [load]);

  if (loaded.status === 'loading' || (loaded.status === 'ready' && !draft)) return (
    <OwnerScreen>
      <View style={styles.row} accessibilityLiveRegion="polite">
        <ActivityIndicator color={colors.primary} accessible={false} />
        <Text style={screenText.body}>Loading hours…</Text>
      </View>
    </OwnerScreen>
  );
  if (loaded.status === 'error' || !draft) return (
    <OwnerScreen>
      <Card>
        <Text accessibilityRole="alert" style={screenText.body}>
          {loaded.status === 'error' && loaded.failure ? calendarFailureMessage(loaded.failure) : 'Couldn’t load the hours.'}
        </Text>
        <Button label="Try again" variant="secondary" onPress={load} />
      </Card>
    </OwnerScreen>
  );

  const { schedule, courts, today } = loaded;
  const initial = scheduleDraftFrom(schedule.schedule);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const edit = (next: ScheduleDraft) => { setDraft(next); setMessage(null); };
  const editDay = (day: number, bands: BandDraft[]) => edit({ ...draft, weekly: draft.weekly.map((b, i) => (i === day ? bands : b)) });
  const upcoming = draft.closures.filter((date) => date >= today);
  const save = async () => {
    let built;
    try { built = scheduleFromDraft(draft, today); } catch (error) {
      setMessage({ text: error instanceof HoursDraftError ? error.message : 'Check the hours and rates.', conflict: false }); return;
    }
    setBusy(true); setMessage(null);
    const outcome = await liveSaveVenueSchedule({ venue_id: venueId, expected_revision: schedule.revision, schedule: built });
    setBusy(false);
    if (outcome.ok) {
      setLoaded({ ...loaded, schedule: outcome.value }); setDraft(scheduleDraftFrom(outcome.value.schedule));
      setMessage({ text: 'Hours and closures saved.', conflict: false }); return;
    }
    setMessage({ text: calendarFailureMessage(outcome.failure), conflict: outcome.failure.kind === 'rejected' && outcome.failure.reason === 'version_conflict' });
  };

  return (
    <OwnerScreen>
      <Card>
        <Text accessibilityRole="header" style={screenText.title}>Opening hours and rates</Text>
        <Text style={screenText.body}>
          Set when players can book and the hourly rate for each stretch, in Philippine time. Hours that run past midnight continue into the next day.
          Every court follows these hours unless you narrow them below.
        </Text>
        {schedule.revision === null && <Text style={screenText.body}>No hours are set yet, so courts can’t be blocked or booked.</Text>}
        {draft.weekly.map((bands, day) => (
          <DayHours key={DAY_NAMES[day]} name={DAY_NAMES[day]!} bands={bands} disabled={busy}
            onChange={(next) => editDay(day, next)} onCopy={() => edit(copyDayToAll(draft, day))} />
        ))}
      </Card>
      <Card>
        <Text accessibilityRole="header" style={screenText.title}>Venue closures</Text>
        <Text style={screenText.body}>Close the whole venue on a date, such as a holiday. Every court closes for the full day.</Text>
        {upcoming.length === 0 && <Text style={screenText.body}>No upcoming closures.</Text>}
        {upcoming.map((date) => (
          <View key={date} style={styles.row}>
            <Text style={[screenText.label, styles.grow]}>Closed {dayTitle(date)}</Text>
            <Button label="Reopen" variant="secondary" disabled={busy} accessibilityLabel={`Reopen ${dayTitle(date)}`} onPress={() => edit(toggleClosure(draft, date))} />
          </View>
        ))}
        {draft.special.filter((e) => e.date >= today).map((e) => (
          <Text key={e.date} style={screenText.body}>Special hours on {dayTitle(e.date)} (set by pickly).</Text>
        ))}
        {closureDate && <OptionStepper label="Date to close" options={closureDateOptions(today)} value={closureDate} format={dayTitle} disabled={busy} jump={7} jumpLabel="1 week" onChange={setClosureDate} />}
        <Button label="Close the venue on this date" variant="secondary" disabled={busy || !closureDate || draft.closures.includes(closureDate)}
          onPress={() => closureDate && edit(toggleClosure(draft, closureDate))} />
      </Card>
      <Card>
        {message && <Text accessibilityRole={message.conflict ? 'alert' : undefined} accessibilityLiveRegion="polite" style={screenText.body}>{message.text}</Text>}
        {message?.conflict && <Button label="Reload latest" variant="secondary" onPress={load} />}
        <Button label={dirty ? 'Save hours and closures' : 'No unsaved changes'} loading={busy} disabled={!dirty || busy || message?.conflict} onPress={() => void save()} />
        {dirty && <Button label="Discard changes" variant="secondary" disabled={busy} onPress={() => { setDraft(initial); setMessage(null); }} />}
      </Card>
      {/* Keyed by revision: a reload with newer rules remounts the form. */}
      {courts.map((court) => <Card key={`${court.court_id}:${court.revision}`}><CourtHoursForm court={court} today={today} onReload={load} /></Card>)}
    </OwnerScreen>
  );
}

function DayHours({ name, bands, disabled, onChange, onCopy }: {
  name: string; bands: BandDraft[]; disabled: boolean; onChange: (bands: BandDraft[]) => void; onCopy: () => void;
}) {
  const update = (index: number, patch: Partial<BandDraft>) => onChange(bands.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  const last = bands[bands.length - 1];
  return (
    <View style={styles.day}>
      <Text accessibilityRole="header" style={styles.dayName}>{name}</Text>
      {bands.length === 0 && <Text style={screenText.body}>Closed</Text>}
      {bands.map((band, index) => {
        const ends = Array.from({ length: 48 }, (_, i) => band.start + (i + 1) * 30);
        return (
          <View key={index} style={styles.band}>
            <OptionStepper label={index ? `${name} stretch ${index + 1} starts` : `${name} opens`} options={index ? LATER_STARTS : STARTS} value={band.start} format={clockLabel} disabled={disabled}
              onChange={(start) => update(index, { start, end: Math.min(Math.max(band.end, start + 30), start + 1440) })} />
            <OptionStepper label={index ? `${name} stretch ${index + 1} ends` : `${name} closes`} options={ends} value={band.end} format={clockLabel} disabled={disabled}
              onChange={(end) => update(index, { end })} />
            <Field label="Hourly rate (₱)" value={band.pesos} keyboardType="decimal-pad" placeholder="400" maxLength={12} editable={!disabled}
              accessibilityLabel={`${name} hourly rate from ${clockLabel(band.start)}, in pesos`} onChangeText={(pesos) => update(index, { pesos })} />
            <Button label="Remove these hours" variant="secondary" disabled={disabled} onPress={() => onChange(bands.filter((_, i) => i !== index))} />
          </View>
        );
      })}
      <View style={styles.row}>
        <Button label={bands.length ? 'Add a later stretch' : 'Open this day'} variant="secondary" disabled={disabled || (last ? last.end >= 1440 : false)}
          accessibilityLabel={`${bands.length ? 'Add a later stretch on' : 'Open'} ${name}`} onPress={() => onChange(addBand(bands))} style={styles.grow} />
        <Button label="Copy to every day" variant="secondary" disabled={disabled} accessibilityLabel={`Copy ${name} hours to every day`} onPress={onCopy} style={styles.grow} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  grow: { flexGrow: 1 },
  day: { gap: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  dayName: { fontFamily: fonts.semibold, color: colors.text, fontSize: 17, lineHeight: 24 },
  band: { gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.background },
});
