import { useMemo, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import {
  MAX_DATE, MIN_DATE, WEEKDAY_HEADINGS, clampDate, dayOfMonth, longDateText, monthTitle, monthWeeks, sameMonth, shiftDays, shiftMonths,
  startOfMonth, weekOf, weekdayText,
} from './dates';

/** `busy` days have something booked; `attention` days need the viewer (pending requests, holds). */
export type DayMark = 'busy' | 'attention';
const DEFAULT_MARK_LABELS: Record<DayMark, string> = { busy: 'has bookings', attention: 'needs attention' };

/**
 * A week of days that opens into a month grid. Arrows and horizontal swipes move a week
 * (a month while the grid is open); choosing a day closes the grid.
 */
export function DateStrip({ value, today, onChange, marks, markLabels, min = MIN_DATE, max = MAX_DATE }: {
  value: string; today: string; onChange: (date: string) => void;
  marks?: ReadonlyMap<string, DayMark>; markLabels?: Partial<Record<DayMark, string>>; min?: string; max?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth(value));
  const labels = { ...DEFAULT_MARK_LABELS, ...markLabels };
  const pick = (date: string) => {
    setExpanded(false);
    const next = clampDate(date, min, max);
    if (next !== value) onChange(next);
  };
  const canStep = (direction: 1 | -1) => stepTarget(expanded, month, value, min, max, direction) !== null;
  const step = (direction: 1 | -1) => {
    const target = stepTarget(expanded, month, value, min, max, direction);
    if (target?.kind === 'month') setMonth(target.month); else if (target) onChange(target.date);
  };
  // Swipes act like the arrows. A new responder follows each new week or month (never mid-swipe).
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderRelease: (_, g) => {
      const target = g.dx <= -40 ? stepTarget(expanded, month, value, min, max, 1) : g.dx >= 40 ? stepTarget(expanded, month, value, min, max, -1) : null;
      if (target?.kind === 'month') setMonth(target.month); else if (target) onChange(target.date);
    },
    onPanResponderTerminationRequest: () => true,
  }), [expanded, month, value, min, max, onChange]);
  const toggle = () => { if (!expanded) setMonth(startOfMonth(value)); setExpanded(!expanded); };
  const shown = expanded ? month : value;
  const cell = (date: string, weekday: boolean, outside = false) => {
    const mark = marks?.get(date);
    const disabled = date < min || date > max;
    const parts = [longDateText(date), date === today ? 'today' : null, mark ? labels[mark] : null];
    return <DayCell key={date} date={date} weekday={weekday} outside={outside} mark={mark} disabled={disabled}
      selected={date === value} isToday={date === today} label={parts.filter(Boolean).join(', ')} onPress={() => pick(date)} />;
  };
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${monthTitle(shown)}. ${expanded ? 'Show one week' : 'Show the whole month'}`}
          accessibilityState={{ expanded }} onPress={toggle} hitSlop={6} style={({ pressed }) => [styles.monthButton, pressed && styles.pressed]}>
          <Text style={styles.month} numberOfLines={1}>{monthTitle(shown)}</Text>
          <Icon name={expanded ? 'chevronUp' : 'chevronDown'} color={colors.textSecondary} size={18} />
        </Pressable>
        <View style={styles.controls}>
          {value !== today && (
            <Pressable accessibilityRole="button" accessibilityLabel="Go to today" onPress={() => pick(today)} hitSlop={4}
              style={({ pressed }) => [styles.today, pressed && styles.pressed]}>
              <Text style={styles.todayText}>Today</Text>
            </Pressable>
          )}
          <IconButton icon="chevronLeft" accessibilityLabel={expanded ? 'Previous month' : 'Previous week'} disabled={!canStep(-1)} onPress={() => step(-1)} />
          <IconButton icon="chevronRight" accessibilityLabel={expanded ? 'Next month' : 'Next week'} disabled={!canStep(1)} onPress={() => step(1)} />
        </View>
      </View>
      {expanded ? (
        <View {...pan.panHandlers} style={styles.monthGrid}>
          <View style={styles.row}>
            {WEEKDAY_HEADINGS.map((heading) => <Text key={heading} style={styles.heading} accessible={false}>{heading}</Text>)}
          </View>
          {monthWeeks(month).map((week) => <View key={week[0]} style={styles.row}>{week.map((date) => cell(date, false, !sameMonth(date, month)))}</View>)}
        </View>
      ) : (
        <View {...pan.panHandlers} style={styles.row}>{weekOf(value).map((date) => cell(date, true))}</View>
      )}
    </View>
  );
}

/** Where an arrow or swipe leads: another month while the grid is open, otherwise the same weekday a week away. */
function stepTarget(expanded: boolean, month: string, value: string, min: string, max: string, direction: 1 | -1):
  { kind: 'month'; month: string } | { kind: 'date'; date: string } | null {
  if (expanded) {
    const next = shiftMonths(month, direction);
    return next < startOfMonth(min) || next > startOfMonth(max) ? null : { kind: 'month', month: next };
  }
  const date = clampDate(shiftDays(value, 7 * direction), min, max);
  return date === value ? null : { kind: 'date', date };
}

function DayCell({ date, weekday, outside, mark, disabled, selected, isToday, label, onPress }: {
  date: string; weekday: boolean; outside: boolean; mark: DayMark | undefined; disabled: boolean;
  selected: boolean; isToday: boolean; label: string; onPress: () => void;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.cell, isToday && !selected && styles.todayCell, selected && styles.selectedCell, pressed && styles.pressed, disabled && styles.faded]}>
      {weekday && <Text style={[styles.weekday, selected && styles.selectedMuted]} maxFontSizeMultiplier={1.4}>{weekdayText(date)}</Text>}
      <Text style={[styles.number, outside && styles.outside, selected && styles.selectedText]} maxFontSizeMultiplier={1.5}>{dayOfMonth(date)}</Text>
      <View style={[styles.dot, mark === 'busy' && styles.busy, mark === 'attention' && styles.attention, selected && mark && styles.selectedDot]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 24, padding: 12, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingLeft: 6 },
  monthButton: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, minHeight: 40 },
  month: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 17, lineHeight: 23, flexShrink: 1 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  today: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 20, backgroundColor: colors.accent },
  todayText: { fontFamily: fonts.semibold, color: colors.onAccent, fontSize: 13, lineHeight: 18 },
  monthGrid: { gap: 4 },
  row: { flexDirection: 'row', gap: 4 },
  heading: { flex: 1, textAlign: 'center', fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 11, lineHeight: 16 },
  cell: { flex: 1, alignItems: 'center', gap: 3, paddingTop: 7, paddingBottom: 6, borderRadius: 14, minHeight: 44 },
  todayCell: { backgroundColor: colors.pendingBackground },
  selectedCell: { backgroundColor: colors.primary },
  weekday: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 11, lineHeight: 15 },
  number: { fontFamily: fonts.semibold, color: colors.text, fontSize: 17, lineHeight: 22 },
  outside: { color: colors.textSecondary, opacity: 0.55 },
  selectedText: { color: colors.onPrimary, opacity: 1 },
  selectedMuted: { color: colors.onPrimaryMuted },
  dot: { width: 6, height: 6, borderRadius: 3 },
  busy: { backgroundColor: colors.primary },
  attention: { backgroundColor: colors.pending },
  selectedDot: { backgroundColor: colors.accent },
  pressed: { opacity: 0.75 },
  faded: { opacity: 0.35 },
});
