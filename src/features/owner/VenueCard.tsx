import type { OwnedVenueSummary } from '@picklyph/domain';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/Icon';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { summaryStatus } from './venueDraft';

type TileTone = 'blue' | 'green' | 'lime';
type Tile = { key: string; icon: IconName; label: string; hint: string; tone: TileTone; onPress: () => void };
const tileTones = {
  blue: { backgroundColor: colors.selectedBackground, color: colors.primary },
  green: { backgroundColor: colors.successBackground, color: colors.success },
  lime: { backgroundColor: colors.pendingBackground, color: colors.pending },
} satisfies Record<TileTone, { backgroundColor: string; color: string }>;

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A managed venue: navy court header with its status, then its tools as an icon grid. */
export function VenueCard({ venue }: { venue: OwnedVenueSummary }) {
  const status = summaryStatus(venue);
  // Bookings and the desk need a published listing with verified ownership; setup only needs edit rights.
  const live = venue.publication_status === 'approved' && venue.claim_status === 'verified';
  const params = { id: venue.id };
  const tiles: Tile[] = [
    ...(venue.editable ? [{ key: 'calendar', icon: 'calendar', label: 'Calendar', hint: 'Court calendar', tone: 'blue',
      onPress: () => router.push({ pathname: '/owner/calendar/[id]', params }) } as const] : []),
    ...(live ? [
      { key: 'desk', icon: 'desk', label: 'Front desk', hint: 'Front desk', tone: 'green', onPress: () => router.push({ pathname: '/owner/desk/[id]', params }) } as const,
      { key: 'requests', icon: 'inbox', label: 'Requests', hint: 'Booking requests', tone: 'lime', onPress: () => router.push({ pathname: '/owner/requests/[id]', params }) } as const,
      { key: 'play', icon: 'players', label: 'Open play', hint: 'Open-play sessions', tone: 'green', onPress: () => router.push({ pathname: '/owner/sessions/[id]', params }) } as const,
    ] : []),
    ...(venue.editable ? [
      { key: 'hours', icon: 'clock', label: 'Hours', hint: 'Hours and closures', tone: 'blue', onPress: () => router.push({ pathname: '/owner/hours/[id]', params }) } as const,
      { key: 'edit', icon: 'edit', label: 'Edit venue', hint: 'Edit details, courts and photos', tone: 'blue', onPress: () => router.push({ pathname: '/owner/venues/[id]', params }) } as const,
    ] : []),
  ];
  return (
    <View style={styles.card}>
      <View style={styles.hero}>
        <CourtLines />
        <View style={styles.top}>
          <View style={styles.mark} accessible={false}><Icon name="court" color={colors.onAccent} size={24} /></View>
          <View style={styles.identity}>
            <Text accessibilityRole="header" style={styles.name} numberOfLines={2}>{venue.name}</Text>
            <View style={styles.place}>
              <Icon name="pin" color={colors.onPrimaryMuted} size={15} />
              <Text style={styles.placeText} numberOfLines={1}>{venue.city}, {venue.province}</Text>
            </View>
          </View>
        </View>
        <View style={styles.chips} accessible accessibilityLabel={`${status.label}. ${count(venue.active_court_count, 'active court')}, ${count(venue.photo_count, 'photo')}.`}>
          <Text style={[styles.chip, status.tone === 'success' ? styles.chipAccent : status.tone === 'error' ? styles.chipError : styles.chipVeil]}>{status.short}</Text>
          <View style={[styles.chip, styles.chipVeil, styles.chipRow]}>
            <Icon name="court" color={colors.onPrimary} size={14} />
            <Text style={styles.chipText}>{count(venue.active_court_count, 'court')}</Text>
          </View>
          <View style={[styles.chip, styles.chipVeil, styles.chipRow]}>
            <Icon name="photo" color={colors.onPrimary} size={14} />
            <Text style={styles.chipText}>{count(venue.photo_count, 'photo')}</Text>
          </View>
        </View>
      </View>
      {status.note && <Text style={styles.note}>{status.note}</Text>}
      {tiles.length > 0 && (
        <View style={styles.grid}>
          {tiles.map((tile) => <ToolTile key={tile.key} tile={tile} venueName={venue.name} />)}
        </View>
      )}
    </View>
  );
}

function ToolTile({ tile, venueName }: { tile: Tile; venueName: string }) {
  const [focused, setFocused] = useState(false);
  const tone = tileTones[tile.tone];
  return (
    <View style={styles.cell}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${tile.hint} for ${venueName}`} onPress={tile.onPress}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={({ pressed }) => [styles.tile, pressed && styles.pressed, focused && styles.focused]}>
        <View style={[styles.icon, { backgroundColor: tone.backgroundColor }]}><Icon name={tile.icon} color={tone.color} size={22} /></View>
        <Text style={styles.label} numberOfLines={2} maxFontSizeMultiplier={1.4}>{tile.label}</Text>
      </Pressable>
    </View>
  );
}

/** Court lines behind the header; purely decorative (matches the Account profile hero). */
function CourtLines() {
  return (
    <View style={styles.court} pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.line, styles.kitchenTop]} />
      <View style={[styles.line, styles.net]} />
      <View style={[styles.line, styles.kitchenBottom]} />
      <View style={[styles.line, styles.centerTop]} />
      <View style={[styles.line, styles.centerBottom]} />
    </View>
  );
}

const line = colors.primaryOverlay;
const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 24, overflow: 'hidden' },
  hero: { backgroundColor: colors.primary, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 16, gap: 14, overflow: 'hidden' },
  court: { position: 'absolute', top: -70, right: -120, width: 230, height: 340, borderWidth: 2, borderColor: line, transform: [{ rotate: '-14deg' }] },
  line: { position: 'absolute', backgroundColor: line },
  kitchenTop: { left: 0, right: 0, top: '34%', height: 2 },
  net: { left: -2, right: -2, top: '50%', height: 4 },
  kitchenBottom: { left: 0, right: 0, top: '66%', height: 2 },
  centerTop: { left: '50%', top: 0, width: 2, height: '34%' },
  centerBottom: { left: '50%', bottom: 0, width: 2, height: '34%' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  mark: { width: 48, height: 48, borderRadius: 16, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  identity: { flex: 1, gap: 3 },
  name: { fontFamily: fonts.extrabold, color: colors.onPrimary, fontSize: 20, lineHeight: 25, letterSpacing: -0.4 },
  place: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  placeText: { flexShrink: 1, fontFamily: fonts.medium, color: colors.onPrimaryMuted, fontSize: 14, lineHeight: 20 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { fontFamily: fonts.semibold, fontSize: 12, lineHeight: 16, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4, overflow: 'hidden' },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  chipText: { fontFamily: fonts.semibold, fontSize: 12, lineHeight: 16, color: colors.onPrimary },
  chipAccent: { backgroundColor: colors.accent, color: colors.onAccent },
  chipVeil: { backgroundColor: colors.primaryOverlay, color: colors.onPrimary },
  chipError: { backgroundColor: colors.errorBackground, color: colors.error },
  note: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19, paddingHorizontal: 18, paddingTop: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 8 },
  cell: { width: '33.333%', padding: 4 },
  tile: { alignItems: 'center', gap: 7, paddingTop: 12, paddingBottom: 10, paddingHorizontal: 4, borderRadius: 18, borderWidth: 2, borderColor: 'transparent' },
  icon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  label: { fontFamily: fonts.semibold, color: colors.text, fontSize: 13, lineHeight: 17, textAlign: 'center' },
  pressed: { backgroundColor: colors.background, transform: [{ scale: 0.97 }] },
  focused: { borderColor: colors.text },
});
