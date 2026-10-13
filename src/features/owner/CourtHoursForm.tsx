import type { CalendarCourt, CourtHoursView, CourtWindow } from '@picklyph/domain';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Disclosure } from '@/components/ui/Disclosure';
import { IconButton, IconPill } from '@/components/ui/IconButton';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { calendarFailureMessage } from './calendarClient';
import { clockLabel, dayTitle } from './calendarModel';
import { Choice, OptionStepper } from './FormControls';
import {
  DAY_NAMES, HoursDraftError, addCourtWindow, closureDateOptions, courtDraftFrom, courtHoursFromDraft, courtSummary, windowsSummary,
  type CourtDraft,
} from './hoursDraft';
import { liveSaveCourtHours } from './liveOwner';
import { SaveFooter } from './SaveFooter';

const STARTS = Array.from({ length: 48 }, (_, i) => i * 30);

/**
 * One court's own hours (narrowing venue hours) and closed dates, as a row that opens to edit.
 * Venue rates still apply.
 */
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
    <Disclosure title={court.name} summary={`${courtSummary(draft, today)}${dirty ? ' · unsaved changes' : ''}`}
      accessory={court.status === 'inactive' ? <StatusBadge label="Inactive" /> : undefined}>
      <View accessibilityRole="radiogroup" accessibilityLabel={`${court.name} weekly hours`} style={styles.options}>
        <Choice label="Same as venue hours" selected={!draft.custom} disabled={busy} onPress={() => edit({ ...draft, custom: false })} />
        <Choice label="Its own hours" selected={draft.custom} disabled={busy} onPress={() => edit({ ...draft, custom: true })} />
      </View>
      {draft.custom && <>
        <Text style={screenText.body}>This court opens only during these periods and the venue’s hours.</Text>
        <View>
          {draft.weekly.map((windows, day) => (
            <Disclosure key={DAY_NAMES[day]} title={DAY_NAMES[day]!} summary={windowsSummary(windows, clockLabel)}>
              {windows.map((w, index) => (
                <View key={index} style={styles.window}>
                  <View style={styles.row}>
                    <Text style={[styles.windowName, styles.grow]}>{windows.length > 1 ? `Period ${index + 1}` : 'Open hours'}</Text>
                    <IconButton icon="trash" tone="danger" disabled={busy} onPress={() => editDay(day, windows.filter((_, i) => i !== index))}
                      accessibilityLabel={`Remove ${court.name} ${DAY_NAMES[day]} period from ${clockLabel(w.start_minute)}`} />
                  </View>
                  <OptionStepper label={`${DAY_NAMES[day]} opens`} options={STARTS} value={w.start_minute} format={clockLabel} disabled={busy}
                    onChange={(start) => editDay(day, windows.map((x, i) => (i === index ? { start_minute: start, end_minute: Math.max(x.end_minute, start + 30) } : x)))} />
                  <OptionStepper label={`${DAY_NAMES[day]} closes`} options={STARTS.map((m) => m + 30).filter((m) => m > w.start_minute)} value={w.end_minute}
                    format={clockLabel} disabled={busy} onChange={(end) => editDay(day, windows.map((x, i) => (i === index ? { ...x, end_minute: end } : x)))} />
                </View>
              ))}
              <View style={styles.row}>
                {windows.length === 0 ? <Text style={[screenText.body, styles.grow]}>Closed all day</Text> : <View style={styles.grow} />}
                <IconButton icon="plus"
                  disabled={busy || windows.length >= 4 || (windows.length > 0 && windows[windows.length - 1]!.end_minute >= 1410)}
                  accessibilityLabel={`${windows.length ? 'Add another period on' : 'Open'} ${DAY_NAMES[day]} for ${court.name}`}
                  onPress={() => editDay(day, addCourtWindow(windows))} />
              </View>
            </Disclosure>
          ))}
        </View>
      </>}
      <Text style={screenText.label}>Court closures</Text>
      <View>
        {upcoming.length === 0 && <Text style={screenText.body}>No upcoming closures for this court.</Text>}
        {upcoming.map((date) => (
          <View key={date} style={styles.item}>
            <Text style={[screenText.body, styles.grow]}>Closed {dayTitle(date)}</Text>
            <IconButton icon="close" tone="danger" disabled={busy} accessibilityLabel={`Reopen ${court.name} on ${dayTitle(date)}`}
              onPress={() => edit({ ...draft, closures: draft.closures.filter((d) => d !== date) })} />
          </View>
        ))}
      </View>
      <OptionStepper label="Date to close this court" options={closureDateOptions(today)} value={closureDate} format={dayTitle} disabled={busy}
        jump={7} jumpLabel="1 week" onChange={setClosureDate} />
      <View style={styles.end}>
        <IconPill icon="plus" label="Add closure" accessibilityLabel={`Close ${court.name} on ${dayTitle(closureDate)}`}
          disabled={busy || draft.closures.includes(closureDate)} onPress={() => edit({ ...draft, closures: [...draft.closures, closureDate].sort() })} />
      </View>
      <SaveFooter dirty={dirty} label={`Save ${court.name}`} saving={busy} message={message} onReload={onReload}
        onSave={() => void save()} onDiscard={() => { setDraft(initial); setMessage(null); }} />
    </Disclosure>
  );
}

const styles = StyleSheet.create({
  options: { gap: 8 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  grow: { flexGrow: 1, flexShrink: 1 },
  end: { alignItems: 'flex-end' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, borderTopWidth: 1, borderTopColor: colors.border },
  window: { gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.background },
  windowName: { fontFamily: fonts.semibold, color: colors.text, fontSize: 15, lineHeight: 22 },
});
