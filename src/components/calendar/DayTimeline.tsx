import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { hourText } from './dates';
import { assignLanes, frameOf, hourMarks, minuteAt, SLOT_MINUTES, type Span } from './timeline';

export type TimelineTone = 'rental' | 'session' | 'block' | 'hold' | 'done' | 'muted';
/** `open` shades everything outside those spans as closed; null leaves the whole column open. */
export type TimelineColumn = { key: string; title: string; note?: string; open: readonly Span[] | null; disabled?: boolean };
export type TimelineEvent = Span & {
  key: string; column: string; title: string; detail?: string; tone: TimelineTone;
  /** The item starts before or ends after this day; its edge is drawn flat. */
  continuesBefore?: boolean; continuesAfter?: boolean;
  accessibilityLabel: string; onPress?: () => void;
};

const GUTTER = 50;
const HEADER = 48;
const PAD = 10;
const MIN_COLUMN = 104;

export const TIMELINE_TONES = {
  rental: { backgroundColor: colors.primary, borderColor: colors.primary, color: colors.onPrimary, dashed: false },
  session: { backgroundColor: colors.brandGreen, borderColor: colors.brandGreen, color: colors.onPrimary, dashed: false },
  block: { backgroundColor: colors.selectedBackground, borderColor: colors.textSecondary, color: colors.text, dashed: true },
  hold: { backgroundColor: colors.accent, borderColor: colors.pending, color: colors.onAccent, dashed: false },
  done: { backgroundColor: colors.successBackground, borderColor: colors.success, color: colors.success, dashed: false },
  muted: { backgroundColor: colors.background, borderColor: colors.border, color: colors.textSecondary, dashed: false },
} satisfies Record<TimelineTone, { backgroundColor: string; borderColor: string; color: string; dashed: boolean }>;

/**
 * One day as a grid: hours down the side, one column per court. Columns scroll sideways when
 * they don't fit. Tapping open space reports the 30-minute slot under the finger; every event
 * is its own accessible button, so screen-reader users never need the grid itself.
 */
export function DayTimeline({ columns, events, range, now = null, hourHeight = 56, onSlotPress, selection = null }: {
  columns: readonly TimelineColumn[]; events: readonly TimelineEvent[]; range: Span; now?: number | null; hourHeight?: number;
  onSlotPress?: (column: string, minute: number) => void; selection?: (Span & { column: string; label: string }) | null;
}) {
  const [width, setWidth] = useState(0);
  const height = ((range.end - range.start) / 60) * hourHeight;
  const available = Math.max(0, width - GUTTER);
  const columnWidth = columns.length ? Math.max(MIN_COLUMN, available / columns.length) : available;
  const overflow = columnWidth * columns.length > available + 1;
  const marks = hourMarks(range);
  const nowTop = now !== null && now >= range.start && now <= range.end ? PAD + ((now - range.start) / 60) * hourHeight : null;
  return (
    <View style={styles.frame} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {width > 0 && (
        <View style={styles.row}>
          <View style={{ width: GUTTER }} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={[styles.corner, { height: HEADER }]} />
            <View style={{ height: height + PAD * 2 }}>
              {marks.map((minute) => (
                <Text key={minute} maxFontSizeMultiplier={1.2} style={[styles.hour, { top: PAD + ((minute - range.start) / 60) * hourHeight - 8 }]}>{hourText(minute)}</Text>
              ))}
              {nowTop !== null && <View style={[styles.nowDot, { top: nowTop - 4 }]} />}
            </View>
          </View>
          <ScrollView horizontal scrollEnabled={overflow} showsHorizontalScrollIndicator={overflow} bounces={false}>
            <View style={{ width: columnWidth * columns.length }}>
              <View style={[styles.headers, { height: HEADER }]}>
                {columns.map((column) => (
                  <View key={column.key} style={[styles.header, { width: columnWidth }]} accessible accessibilityRole="header"
                    accessibilityLabel={[column.title, column.note].filter(Boolean).join(', ')}>
                    <Text style={[styles.title, column.disabled && styles.faded]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{column.title}</Text>
                    {column.note && <Text style={styles.note} numberOfLines={1} maxFontSizeMultiplier={1.3}>{column.note}</Text>}
                  </View>
                ))}
              </View>
              <View style={[styles.row, { height: height + PAD * 2 }]}>
                {columns.map((column) => (
                  <Column key={column.key} column={column} events={events.filter((event) => event.column === column.key)} range={range}
                    hourHeight={hourHeight} width={columnWidth} height={height} marks={marks} onSlotPress={onSlotPress}
                    selection={selection?.column === column.key ? selection : null} />
                ))}
                {nowTop !== null && <View pointerEvents="none" style={[styles.now, { top: nowTop - 1 }]} />}
              </View>
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function Column({ column, events, range, hourHeight, width, height, marks, onSlotPress, selection }: {
  column: TimelineColumn; events: readonly TimelineEvent[]; range: Span; hourHeight: number; width: number; height: number;
  marks: readonly number[]; onSlotPress?: (column: string, minute: number) => void; selection: (Span & { label: string }) | null;
}) {
  const shaded = column.disabled || column.open !== null;
  const y = (minute: number) => PAD + ((minute - range.start) / 60) * hourHeight;
  const chosen = selection ? frameOf(selection, range, hourHeight) : null;
  return (
    <View style={[styles.column, { width, height: height + PAD * 2 }]}>
      <View pointerEvents="none" style={[styles.fill, { top: PAD, height, backgroundColor: shaded ? colors.closedBackground : colors.surface }]} />
      {!column.disabled && column.open?.map((span) => {
        const frame = frameOf(span, range, hourHeight);
        return frame && <View key={span.start} pointerEvents="none" style={[styles.fill, { top: PAD + frame.top, height: frame.height, backgroundColor: colors.surface }]} />;
      })}
      {marks.map((minute) => <View key={minute} pointerEvents="none" style={[styles.line, { top: y(minute) }]} />)}
      {marks.slice(0, -1).map((minute) => <View key={`h${minute}`} pointerEvents="none" style={[styles.halfLine, { top: y(minute + SLOT_MINUTES) }]} />)}
      {onSlotPress && !column.disabled && (
        <Pressable accessible={false} style={[styles.fill, { top: PAD, height }]}
          onPress={(event) => onSlotPress(column.key, minuteAt(event.nativeEvent.locationY, hourHeight, range))} />
      )}
      {chosen && selection && (
        <View pointerEvents="none" style={[styles.selection, { top: PAD + chosen.top + 1, height: Math.max(22, chosen.height - 2) }]}>
          <Text style={styles.selectionText} numberOfLines={2} maxFontSizeMultiplier={1.2}>{selection.label}</Text>
        </View>
      )}
      {assignLanes(events).map(({ item, lane, lanes }) => {
        const frame = frameOf(item, range, hourHeight);
        if (!frame) return null;
        const tone = TIMELINE_TONES[item.tone];
        const laneWidth = (width - 6) / lanes;
        const blockHeight = Math.max(22, frame.height - 2);
        const roomy = blockHeight >= 44;
        return (
          <Pressable key={item.key} accessibilityRole={item.onPress ? 'button' : 'text'} accessibilityLabel={item.accessibilityLabel}
            disabled={!item.onPress} onPress={item.onPress}
            style={({ pressed }) => [styles.event, {
              top: PAD + frame.top + 1, height: blockHeight, left: 3 + lane * laneWidth, width: laneWidth - (lanes > 1 ? 2 : 0),
              backgroundColor: tone.backgroundColor, borderColor: tone.borderColor, borderStyle: tone.dashed ? 'dashed' : 'solid',
            }, item.continuesBefore && styles.flatTop, item.continuesAfter && styles.flatBottom, pressed && styles.pressed]}>
            <Text numberOfLines={roomy ? 2 : 1} maxFontSizeMultiplier={1.2} style={[styles.eventTitle, { color: tone.color }]}>{item.title}</Text>
            {item.detail && roomy && (
              <Text numberOfLines={Math.max(1, Math.floor((blockHeight - 36) / 15))} maxFontSizeMultiplier={1.2}
                style={[styles.eventDetail, { color: tone.color }]}>{item.detail}</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Colour key for the tones a screen uses; hidden from screen readers, whose event labels already name each kind. */
export function TimelineLegend({ items }: { items: readonly { tone: TimelineTone; label: string }[] }) {
  return (
    <View style={styles.legend} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {items.map(({ tone, label }) => {
        const appearance = TIMELINE_TONES[tone];
        return (
          <View key={tone} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: appearance.backgroundColor, borderColor: appearance.borderColor, borderStyle: appearance.dashed ? 'dashed' : 'solid' }]} />
            <Text style={styles.legendText}>{label}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 24, overflow: 'hidden', minHeight: 120 },
  row: { flexDirection: 'row' },
  corner: { borderBottomWidth: 1, borderBottomColor: colors.border },
  hour: { position: 'absolute', right: 8, fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 11, lineHeight: 16 },
  headers: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border },
  header: { justifyContent: 'center', paddingHorizontal: 8, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
  title: { fontFamily: fonts.semibold, color: colors.text, fontSize: 14, lineHeight: 19 },
  note: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 11, lineHeight: 15 },
  faded: { color: colors.textSecondary },
  column: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
  fill: { position: 'absolute', left: 0, right: 0 },
  line: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  halfLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.border, opacity: 0.45 },
  now: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: colors.error },
  nowDot: { position: 'absolute', right: 0, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.error },
  selection: { position: 'absolute', left: 3, right: 3, borderRadius: 10, borderWidth: 2, borderColor: colors.primary,
    backgroundColor: colors.pendingBackground, paddingHorizontal: 6, paddingVertical: 3 },
  selectionText: { fontFamily: fonts.semibold, color: colors.text, fontSize: 12, lineHeight: 16 },
  event: { position: 'absolute', borderRadius: 10, borderWidth: 1.5, paddingHorizontal: 6, paddingVertical: 3, overflow: 'hidden', gap: 1 },
  flatTop: { borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  flatBottom: { borderBottomLeftRadius: 2, borderBottomRightRadius: 2 },
  eventTitle: { fontFamily: fonts.semibold, fontSize: 12, lineHeight: 16 },
  eventDetail: { fontFamily: fonts.medium, fontSize: 11, lineHeight: 15, opacity: 0.92 },
  pressed: { opacity: 0.8 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 14, height: 14, borderRadius: 4, borderWidth: 1.5 },
  legendText: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
});
