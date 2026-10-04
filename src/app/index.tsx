import { market } from '@picklyph/domain';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, palette } from '@/theme/colors';

export default function WelcomeScreen() {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.brand}>
              <View style={styles.brandDot} />
              <Text style={styles.brandName}>PicklyPH</Text>
            </View>
            <Text style={styles.country}>{market.countryCode}</Text>
          </View>

          <View
            style={styles.courtArtwork}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <View style={styles.court}>
              <View style={styles.net} />
              <View style={styles.kitchenTop} />
              <View style={styles.kitchenBottom} />
              <View style={styles.centerTop} />
              <View style={styles.centerBottom} />
            </View>
            <View style={styles.ball}>
              <View style={[styles.ballHole, styles.ballHoleOne]} />
              <View style={[styles.ballHole, styles.ballHoleTwo]} />
              <View style={[styles.ballHole, styles.ballHoleThree]} />
            </View>
            <Text style={styles.artworkCaption}>GOOD COURTS. GREAT GAMES.</Text>
          </View>

          <View style={styles.introduction}>
            <Text style={styles.eyebrow}>PICKLEBALL IN THE {market.country.toUpperCase()}</Text>
            <Text accessibilityRole="header" style={styles.title}>
              Your next game{'\n'}starts here.
            </Text>
            <Text style={styles.description}>
              Discover a place to play, bring your crew, and make more time for the court.
            </Text>
          </View>

          <View style={styles.footer}>
            <View style={styles.footerLine} />
            <Text style={styles.footerText}>A little closer to your next court.</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1, alignItems: 'center' },
  content: { flex: 1, width: '100%', maxWidth: 520, padding: 24, gap: 30 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.secondary },
  brandName: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.8 },
  country: { color: colors.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 2 },
  courtArtwork: {
    backgroundColor: colors.primary,
    borderRadius: 28,
    minHeight: 250,
    aspectRatio: 1.2,
    overflow: 'hidden',
    padding: 30,
  },
  court: {
    flex: 1,
    backgroundColor: colors.secondary,
    borderColor: palette.white,
    borderWidth: 2,
    marginBottom: 26,
    transform: [{ rotate: '-10deg' }],
  },
  net: { position: 'absolute', left: 0, right: 0, top: '50%', height: 4, backgroundColor: colors.text },
  kitchenTop: { position: 'absolute', left: 0, right: 0, top: '32%', height: 2, backgroundColor: palette.white },
  kitchenBottom: { position: 'absolute', left: 0, right: 0, top: '68%', height: 2, backgroundColor: palette.white },
  centerTop: { position: 'absolute', top: 0, left: '50%', width: 2, height: '32%', backgroundColor: palette.white },
  centerBottom: { position: 'absolute', bottom: 0, left: '50%', width: 2, height: '32%', backgroundColor: palette.white },
  ball: {
    position: 'absolute',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.accent,
    bottom: 45,
    right: 38,
    transform: [{ rotate: '15deg' }],
  },
  ballHole: { position: 'absolute', width: 10, height: 13, borderRadius: 7, backgroundColor: colors.onAccent },
  ballHoleOne: { top: 16, left: 20 },
  ballHoleTwo: { top: 23, right: 15 },
  ballHoleThree: { bottom: 14, left: 29 },
  artworkCaption: { position: 'absolute', left: 26, bottom: 20, color: colors.onPrimary, fontSize: 11, fontWeight: '700', letterSpacing: 1.7 },
  introduction: { gap: 14 },
  eyebrow: { color: colors.textSecondary, fontSize: 11, fontWeight: '700', letterSpacing: 1.3 },
  title: { color: colors.text, fontSize: 38, lineHeight: 44, fontWeight: '800', letterSpacing: -1.5 },
  description: { color: colors.textSecondary, fontSize: 17, lineHeight: 26, maxWidth: 350 },
  footer: { marginTop: 'auto', paddingTop: 12, gap: 14 },
  footerLine: { width: 42, height: 4, borderRadius: 2, backgroundColor: colors.secondary },
  footerText: { color: colors.textSecondary, fontSize: 13, lineHeight: 20 },
});
