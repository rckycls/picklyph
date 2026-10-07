import type { CalendarCourt, CourtHoursView, CourtWindow } from '@picklyph/domain';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { calendarFailureMessage } from './calendarClient';
import { clockLabel, dayTitle } from './calendarModel';
import { Choice, OptionStepper } from './FormControls';
import {
  DAY_NAMES, HoursDraftError, addCourtWindow, closureDateOptions, courtDraftFrom, courtHoursFromDraft, type CourtDraft,
} from './hoursDraft';
import { liveSaveCourtHours } from './liveOwner';

const STARTS = Array.from({ length: 48 }, (_, i) => i * 30);

/** One court's own hours (narrowing venue hours) and closed dates. Venue rates still apply. */
export function CourtHoursForm({ court, today, onReload }: { court: CalendarCourt; today: string; onReload: () => void }) {
  const [saved, setSaved] = useState<CourtHoursView>({ court_id: court.court_id, revision: court.revision, hours: court.hours });
  const [draft, setDraft] = useState<CourtDraft>(() => courtDraftFrom(court.hours));
  const [closureDate, setClosureDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; conflict: boolean } | null>(null);
  const initial = courtDraftFrom(saved.hours);
  const dirty = JSON.stringify({ ...draft, weekly: draft.custom ? draft.weekly : null }) !== JSON.stringify({ ...initial, weekly: initial.custom ? initial.weekly : null });
  const edit = (next: CourtDraft) => { setDraft(next); setMessage(null); };
  const editDay = (day: number, windows: CourtWindow[]) => edit({ ...draft, weekly: draft.weekly.map((w, i) => (i === day ? windows : w)) });
  const upcoming = draft.closures.filter((date) => date >= today);
  const save = async () => {
    let hours;
    try { hours = courtHoursFromDraft(draft, today); } catch (error) {
      setMessage({ text: error instanceof HoursDraftError ? error.message : 'Check this court’s hours.', conflict: false }); return;
    }
    setBusy(true); setMessage(null);
    const outcome = await liveSaveCourtHours({ court_id: court.court_id, expected_revision: saved.revision, hours });
    setBusy(false);
    if (outcome.ok) { setSaved(outcome.value); setDraft(courtDraftFrom(outcome.value.hours)); setMessage({ text: `${court.name} hours saved.`, conflict: false }); return; }
    setMessage({ text: calendarFailureMessage(outcome.failure), conflict: outcome.failure.kind === 'rejected' && outcome.failure.reason === 'version_conflict' });
  };
  return (
    <View style={styles.form}>
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={screenText.title}>{court.name} hours</Text>
        {court.status === 'inactive' && <StatusBadge label="Inactive" />}
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel={`${court.name} weekly hours`} style={styles.options}>
        <Choice label="Same as venue hours" selected={!draft.custom} disabled={busy} onPress={() => edit({ ...draft, custom: false })} />
        <Choice label="Its own hours" selected={draft.custom} disabled={busy} onPress={() => edit({ ...draft, custom: true })} />
      </View>
      {draft.custom && <>
        <Text style={screenText.body}>This court opens only during these periods and the venue’s hours. Rates come from the venue’s hours.</Text>
        {draft.weekly.map((windows, day) => (
          <View key={DAY_NAMES[day]} style={styles.day}>
            <Text style={styles.dayName}>{DAY_NAMES[day]}</Text>
            {windows.length === 0 && <Text style={screenText.body}>Closed</Text>}
            {windows.map((w, index) => (
              <View key={index} style={styles.window}>
                <OptionStepper label={`${DAY_NAMES[day]} opens`} options={STARTS} value={w.start_minute} format={clockLabel} disabled={busy}
                  onChange={(start) => editDay(day, windows.map((x, i) => (i === index ? { start_minute: start, end_minute: Math.max(x.end_minute, start + 30) } : x)))} />
                <OptionStepper label={`${DAY_NAMES[day]} closes`} options={STARTS.map((m) => m + 30).filter((m) => m > w.start_minute)} value={w.end_minute}
                  format={clockLabel} disabled={busy} onChange={(end) => editDay(day, windows.map((x, i) => (i === index ? { ...x, end_minute: end } : x)))} />
                <Button label="Remove this period" variant="secondary" disabled={busy} onPress={() => editDay(day, windows.filter((_, i) => i !== index))} />
              </View>
            ))}
            <Button label={windows.length ? 'Add another period' : 'Open this day'} variant="secondary"
              disabled={busy || windows.length >= 4 || (windows.length > 0 && windows[windows.length - 1]!.end_minute >= 1410)}
              accessibilityLabel={`${windows.length ? 'Add another period on' : 'Open'} ${DAY_NAMES[day]} for ${court.name}`} onPress={() => editDay(day, addCourtWindow(windows))} />
          </View>
        ))}
      </>}
      <Text style={screenText.label}>Court closures</Text>
      {upcoming.length === 0 && <Text style={screenText.body}>No upcoming closures for this court.</Text>}
      {upcoming.map((date) => (
        <View key={date} style={styles.row}>
          <Text style={[screenText.body, styles.grow]}>Closed {dayTitle(date)}</Text>
          <Button label="Reopen" variant="secondary" disabled={busy} accessibilityLabel={`Reopen ${court.name} on ${dayTitle(date)}`}
            onPress={() => edit({ ...draft, closures: draft.closures.filter((d) => d !== date) })} />
        </View>
      ))}
      <OptionStepper label="Date to close this court" options={closureDateOptions(today)} value={closureDate} format={dayTitle} disabled={busy}
        jump={7} jumpLabel="1 week" onChange={setClosureDate} />
      <Button label="Close this court on that date" variant="secondary" disabled={busy || draft.closures.includes(closureDate)}
        onPress={() => edit({ ...draft, closures: [...draft.closures, closureDate].sort() })} />
      {message && <Text accessibilityRole={message.conflict ? 'alert' : undefined} accessibilityLiveRegion="polite" style={screenText.body}>{message.text}</Text>}
      <Button label={dirty ? `Save ${court.name} hours` : 'No unsaved changes'} loading={busy} disabled={!dirty || busy || message?.conflict} onPress={() => void save()} />
      {dirty && <Button label="Discard changes" variant="secondary" disabled={busy} onPress={() => { setDraft(initial); setMessage(null); }} />}
      {message?.conflict && <Button label="Reload latest" variant="secondary" onPress={onReload} />}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12 }, options: { gap: 8 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  grow: { flexGrow: 1, flexShrink: 1 },
  day: { gap: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  dayName: { fontFamily: fonts.semibold, color: colors.text, fontSize: 16, lineHeight: 22 },
  window: { gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.background },
});
