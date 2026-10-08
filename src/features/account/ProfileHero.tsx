import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { TabIcon } from '@/components/ui/TabIcon';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

// Hole positions as fractions of the ball's size.
const HOLES: readonly (readonly [number, number])[] = [[0.16, 0.24], [0.74, 0.18], [0.82, 0.62], [0.2, 0.74], [0.5, 0.06], [0.5, 0.86]];

export type HeroStat = { label: string; value: string; accessibilityLabel?: string };
export type HeroChip = { label: string; tone: 'accent' | 'veil' };

/** A pickleball: lime ball, a few holes, and the player's initials (or a guest silhouette). */
export function BallAvatar({ initials, size = 58 }: { initials: string; size?: number }) {
  const hole = size * 0.1;
  return (
    <View style={[styles.ball, { width: size, height: size, borderRadius: size / 2 }]} accessible={false}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {HOLES.map(([x, y]) => (
        <View key={`${x}-${y}`} style={[styles.hole, { width: hole, height: hole * 1.3, borderRadius: hole, left: size * x - hole / 2, top: size * y - hole / 2 }]} />
      ))}
      {initials
        ? <Text style={[styles.initials, { fontSize: size * 0.36, lineHeight: size * 0.44 }]} numberOfLines={1}>{initials}</Text>
        : <View style={{ transform: [{ scale: size / 52 }] }}><TabIcon name="account" color={colors.onAccent} /></View>}
    </View>
  );
}

/** The profile photo when there is one, otherwise the pickleball with initials. */
export function Avatar({ photoUri, initials, size = 58 }: { photoUri?: string | null; initials: string; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!photoUri || failed === photoUri) return <BallAvatar initials={initials} size={size} />;
  return <Image source={{ uri: photoUri }} onError={() => setFailed(photoUri)} accessible accessibilityLabel="Your profile photo"
    style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.accent }} />;
}

/** Court lines behind the hero; purely decorative. */
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

type ProfileHeroProps = {
  /** null renders a placeholder while the name loads. */
  name: string | null;
  initials: string;
  photoUri?: string | null;
  detail?: string;
  /** Emails read better on one line, shortened in the middle, than broken mid-word. */
  detailIsEmail?: boolean;
  chips?: readonly HeroChip[];
  stats?: readonly HeroStat[];
  action?: { label: string; accessibilityLabel: string; onPress: () => void };
};

export function ProfileHero({ name, initials, photoUri, detail, detailIsEmail, chips = [], stats = [], action }: ProfileHeroProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.hero}>
      <CourtLines />
      <View style={styles.top}>
        <View style={styles.ring}><Avatar photoUri={photoUri} initials={initials} /></View>
        <View style={styles.identity}>
          {name === null
            ? <View style={styles.namePlaceholder} accessibilityLabel="Loading your name" />
            : <Text accessibilityRole="header" style={styles.name} numberOfLines={2}>{name}</Text>}
          {detail && <Text style={styles.detail} numberOfLines={detailIsEmail ? 1 : 2} ellipsizeMode={detailIsEmail ? 'middle' : 'tail'}>{detail}</Text>}
        </View>
        {action && (
          <Pressable accessibilityRole="button" accessibilityLabel={action.accessibilityLabel} onPress={action.onPress}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} hitSlop={8}
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed, focused && styles.actionFocused]}>
            <Text style={styles.actionLabel}>{action.label}</Text>
          </Pressable>
        )}
      </View>
      {chips.length > 0 && (
        <View style={styles.chips}>
          {chips.map((chip) => (
            <Text key={chip.label} style={[styles.chip, chip.tone === 'accent' ? styles.chipAccent : styles.chipVeil]}>{chip.label}</Text>
          ))}
        </View>
      )}
      {stats.length > 0 && (
        <View style={styles.stats}>
          {stats.map((stat, index) => (
            <View key={stat.label} style={[styles.stat, index > 0 && styles.statDivider]} accessible
              accessibilityLabel={stat.accessibilityLabel ?? `${stat.label}: ${stat.value}`}>
              <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{stat.value}</Text>
              <Text style={styles.statLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{stat.label}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const line = colors.primaryOverlay;
const styles = StyleSheet.create({
  hero: { backgroundColor: colors.primary, borderRadius: 24, paddingHorizontal: 18, paddingVertical: 18, gap: 14, overflow: 'hidden' },
  court: { position: 'absolute', top: -60, right: -110, width: 230, height: 360, borderWidth: 2, borderColor: line, transform: [{ rotate: '-14deg' }] },
  line: { position: 'absolute', backgroundColor: line },
  kitchenTop: { left: 0, right: 0, top: '34%', height: 2 },
  net: { left: -2, right: -2, top: '50%', height: 4 },
  kitchenBottom: { left: 0, right: 0, top: '66%', height: 2 },
  centerTop: { left: '50%', top: 0, width: 2, height: '34%' },
  centerBottom: { left: '50%', bottom: 0, width: 2, height: '34%' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  ring: { borderRadius: 40, borderWidth: 3, borderColor: colors.onPrimary },
  ball: { backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  hole: { position: 'absolute', backgroundColor: colors.onAccent, opacity: 0.14 },
  initials: { fontFamily: fonts.extrabold, color: colors.onAccent, letterSpacing: -1 },
  action: { alignSelf: 'flex-start', minHeight: 34, borderRadius: 17, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: colors.primaryOverlay, borderWidth: 2, borderColor: 'transparent' },
  actionPressed: { transform: [{ scale: 0.97 }] },
  actionFocused: { borderColor: colors.onPrimary },
  actionLabel: { fontFamily: fonts.semibold, color: colors.onPrimary, fontSize: 13, lineHeight: 18 },
  identity: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.extrabold, color: colors.onPrimary, fontSize: 21, lineHeight: 26, letterSpacing: -0.5 },
  namePlaceholder: { width: 130, height: 20, marginVertical: 3, borderRadius: 8, backgroundColor: colors.primaryOverlay },
  detail: { fontFamily: fonts.medium, color: colors.onPrimaryMuted, fontSize: 14, lineHeight: 20 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { fontFamily: fonts.semibold, fontSize: 12, lineHeight: 16, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4, overflow: 'hidden' },
  chipAccent: { backgroundColor: colors.accent, color: colors.onAccent },
  chipVeil: { backgroundColor: colors.primaryOverlay, color: colors.onPrimary },
  stats: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: line, paddingTop: 12 },
  stat: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 6, paddingRight: 6 },
  statDivider: { borderLeftWidth: 1, borderLeftColor: line, paddingLeft: 12 },
  statValue: { fontFamily: fonts.extrabold, color: colors.onPrimary, fontSize: 18, lineHeight: 24, letterSpacing: -0.3 },
  statLabel: { flexShrink: 1, fontFamily: fonts.semibold, color: colors.onPrimaryMuted, fontSize: 12, lineHeight: 17 },
});
