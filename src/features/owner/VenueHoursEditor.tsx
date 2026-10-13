import type { CalendarCourt, ScheduleView } from '@picklyph/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Disclosure } from '@/components/ui/Disclosure';
import { Field } from '@/components/ui/Field';
import { IconButton, IconPill } from '@/components/ui/IconButton';
import { screenText } from '@/components/ui/Screen';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { calendarFailureMessage, type CalendarFailure } from './calendarClient';
import { clockLabel, dayTitle, manilaDate } from './calendarModel';
import { CourtHoursForm } from './CourtHoursForm';
import { OptionStepper } from './FormControls';
import {
  DAY_NAMES, HoursDraftError, addBand, closureDateOptions, copyDayToAll, daySummary, resetScheduleSection, scheduleDraftFrom,
  scheduleFromDraft, scheduleSectionDirty, scheduleSectionDraft, toggleClosure,
  type BandDraft, type ScheduleDraft, type ScheduleSection,
} from './hoursDraft';
import { liveCalendar, liveSaveVenueSchedule, liveVenueSchedule } from './liveOwner';
import { OwnerScreen } from './OwnerScreen';
import { SaveFooter } from './SaveFooter';

type Loaded = { status: 'loading' } | { status: 'ready'; schedule: ScheduleView; courts: CalendarCourt[]; today: string }
  | { status: 'error'; failure: CalendarFailure | null };
type Tab = ScheduleSection | 'courts';
type Message = { section: ScheduleSection; text: string; conflict: boolean };
const STARTS = Array.from({ length: 48 }, (_, i) => i * 30);
// A later stretch may continue an overnight period, so it can start after midnight.
const LATER_STARTS = Array.from({ length: 96 }, (_, i) => i * 30);

/**
 * Venue-wide weekly hours and rates, venue closures and per-court hours, one tab each. Hours and
 * closures save separately; each court saves on its own. Days and courts open one at a time.
 */
export function VenueHoursEditor({ venueId }: { venueId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [tab, setTab] = useState<Tab>('hours');
  const [closureDate, setClosureDate] = useState<string | null>(null);
  const [saving, setSaving] = useState<ScheduleSection | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
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
  const hoursDirty = scheduleSectionDirty(draft, initial, 'hours');
  const closuresDirty = scheduleSectionDirty(draft, initial, 'closures');
  const busy = saving !== null;
  const edit = (next: ScheduleDraft) => { setDraft(next); setMessage(null); };
  const editDay = (day: number, bands: BandDraft[]) => edit({ ...draft, weekly: draft.weekly.map((b, i) => (i === day ? bands : b)) });
  const upcoming = draft.closures.filter((date) => date >= today);
  const save = async (section: ScheduleSection) => {
    let built;
    try { built = scheduleFromDraft(scheduleSectionDraft(draft, initial, section), today); } catch (error) {
      setMessage({ section, text: error instanceof HoursDraftError ? error.message : 'Check the hours and rates.', conflict: false }); return;
    }
    setSaving(section); setMessage(null);
    const outcome = await liveSaveVenueSchedule({ venue_id: venueId, expected_revision: schedule.revision, schedule: built });
    setSaving(null);
    if (outcome.ok) {
      const saved = scheduleDraftFrom(outcome.value.schedule);
      setLoaded({ ...loaded, schedule: outcome.value }); setDraft((current) => (current ? resetScheduleSection(current, saved, section) : current));
      setMessage({ section, text: section === 'hours' ? 'Hours and rates saved.' : 'Closures saved.', conflict: false }); return;
    }
    setMessage({ section, text: calendarFailureMessage(outcome.failure), conflict: outcome.failure.kind === 'rejected' && outcome.failure.reason === 'version_conflict' });
  };
  const footer = (section: ScheduleSection, dirty: boolean, label: string) => (
    <SaveFooter dirty={dirty} label={label} saving={saving === section} disabled={busy}
      message={message?.section === section ? message : null} onReload={load}
      onSave={() => void save(section)} onDiscard={() => edit(resetScheduleSection(draft, initial, section))} />
  );
  // A dot marks a tab with unsaved edits, since its Save is out of sight.
  const tabs = [
    { value: 'hours', label: hoursDirty ? 'Hours •' : 'Hours', accessibilityLabel: hoursDirty ? 'Hours, unsaved changes' : 'Hours' },
    { value: 'closures', label: closuresDirty ? 'Closures •' : 'Closures', accessibilityLabel: closuresDirty ? 'Closures, unsaved changes' : 'Closures' },
    { value: 'courts', label: 'Courts', accessibilityLabel: 'Court hours' },
  ] as const;

  return (
    <OwnerScreen>
      <SegmentedControl options={tabs} value={tab} onChange={setTab} accessibilityLabel="Hours sections" />
      <Card style={tab !== 'hours' && styles.hidden}>
        <Text accessibilityRole="header" style={screenText.title}>Opening hours and rates</Text>
        <Text style={screenText.body}>
          When players can book and the hourly rate, in Philippine time. Hours past midnight continue into the next day. Courts follow these hours unless you change them under Courts.
        </Text>
        {schedule.revision === null && <Text style={screenText.body}>No hours are set yet, so courts can’t be blocked or booked.</Text>}
        <View>
          {draft.weekly.map((bands, day) => (
            <DayHours key={DAY_NAMES[day]} name={DAY_NAMES[day]!} bands={bands} disabled={busy}
              onChange={(next) => editDay(day, next)} onCopy={() => edit(copyDayToAll(draft, day))} />
          ))}
        </View>
        {footer('hours', hoursDirty, 'Save hours')}
      </Card>

      <Card style={tab !== 'closures' && styles.hidden}>
        <Text accessibilityRole="header" style={screenText.title}>Venue closures</Text>
        <Text style={screenText.body}>Close the whole venue on a date, such as a holiday. Every court closes for the full day.</Text>
        <View>
          {upcoming.length === 0 && <Text style={screenText.body}>No upcoming closures.</Text>}
          {upcoming.map((date) => (
            <View key={date} style={styles.item}>
              <Text style={[screenText.label, styles.grow]}>Closed {dayTitle(date)}</Text>
              <IconButton icon="close" tone="danger" disabled={busy} accessibilityLabel={`Reopen ${dayTitle(date)}`} onPress={() => edit(toggleClosure(draft, date))} />
            </View>
          ))}
          {draft.special.filter((e) => e.date >= today).map((e) => (
            <View key={e.date} style={styles.item}>
              <Text style={[screenText.body, styles.grow]}>Special hours on {dayTitle(e.date)} (set by pickly).</Text>
            </View>
          ))}
        </View>
        {closureDate && <OptionStepper label="Date to close" options={closureDateOptions(today)} value={closureDate} format={dayTitle} disabled={busy} jump={7} jumpLabel="1 week" onChange={setClosureDate} />}
        <View style={styles.end}>
          <IconPill icon="plus" label="Add closure" accessibilityLabel={closureDate ? `Close the venue on ${dayTitle(closureDate)}` : 'Add closure'}
            disabled={busy || !closureDate || draft.closures.includes(closureDate)} onPress={() => closureDate && edit(toggleClosure(draft, closureDate))} />
        </View>
        {footer('closures', closuresDirty, 'Save closures')}
      </Card>

      <Card style={tab !== 'courts' && styles.hidden}>
        <Text accessibilityRole="header" style={screenText.title}>Court hours</Text>
        <Text style={screenText.body}>Give a court shorter hours or its own closed dates. Venue rates still apply.</Text>
        {/* Keyed by revision: a reload with newer rules remounts the form. */}
        <View>{courts.map((court) => <CourtHoursForm key={`${court.court_id}:${court.revision}`} court={court} today={today} onReload={load} />)}</View>
      </Card>
    </OwnerScreen>
  );
}

function DayHours({ name, bands, disabled, onChange, onCopy }: {
  name: string; bands: BandDraft[]; disabled: boolean; onChange: (bands: BandDraft[]) => void; onCopy: () => void;
}) {
  const update = (index: number, patch: Partial<BandDraft>) => onChange(bands.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  const last = bands[bands.length - 1];
  return (
    <Disclosure title={name} summary={daySummary(bands, clockLabel)}>
      {bands.map((band, index) => {
        const ends = Array.from({ length: 48 }, (_, i) => band.start + (i + 1) * 30);
        return (
          <View key={index} style={styles.band}>
            <View style={styles.row}>
              <Text style={[styles.bandName, styles.grow]}>{bands.length > 1 ? `Stretch ${index + 1}` : 'Open hours'}</Text>
              <IconButton icon="trash" tone="danger" disabled={disabled} onPress={() => onChange(bands.filter((_, i) => i !== index))}
                accessibilityLabel={`Remove ${name} hours from ${clockLabel(band.start)}`} />
            </View>
            <OptionStepper label={index ? `${name} stretch ${index + 1} starts` : `${name} opens`} options={index ? LATER_STARTS : STARTS} value={band.start} format={clockLabel} disabled={disabled}
              onChange={(start) => update(index, { start, end: Math.min(Math.max(band.end, start + 30), start + 1440) })} />
            <OptionStepper label={index ? `${name} stretch ${index + 1} ends` : `${name} closes`} options={ends} value={band.end} format={clockLabel} disabled={disabled}
              onChange={(end) => update(index, { end })} />
            <Field label="Hourly rate (₱)" value={band.pesos} keyboardType="decimal-pad" placeholder="400" maxLength={12} editable={!disabled}
              accessibilityLabel={`${name} hourly rate from ${clockLabel(band.start)}, in pesos`} onChangeText={(pesos) => update(index, { pesos })} />
          </View>
        );
      })}
      <View style={styles.row}>
        {bands.length === 0 ? <Text style={[screenText.body, styles.grow]}>Closed all day</Text> : <View style={styles.grow} />}
        <IconButton icon="plus" disabled={disabled || (last ? last.end >= 1440 : false)} onPress={() => onChange(addBand(bands))}
          accessibilityLabel={bands.length ? `Add a later stretch on ${name}` : `Open ${name}`} />
        <IconButton icon="copy" disabled={disabled} accessibilityLabel={`Copy ${name} hours to every day`} onPress={onCopy} />
      </View>
    </Disclosure>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  grow: { flexGrow: 1, flexShrink: 1 },
  hidden: { display: 'none' },
  end: { alignItems: 'flex-end' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, borderTopWidth: 1, borderTopColor: colors.border },
  band: { gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.background },
  bandName: { fontFamily: fonts.semibold, color: colors.text, fontSize: 15, lineHeight: 22 },
});
