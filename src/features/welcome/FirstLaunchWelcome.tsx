import AsyncStorage from '@react-native-async-storage/async-storage';
import { Redirect, router, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PicklyMascot } from '@/components/mascot/PicklyMascot';
import { Button } from '@/components/ui/Button';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';
import { createWelcomeStore, welcomeDestination, type WelcomeChoice } from './state';

const welcomeStore = createWelcomeStore(AsyncStorage);

/** Only mounted at Discover's entry, so protected/deep-linked routes keep their own routing. */
export function FirstLaunchWelcome({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'welcome' | 'done'>('checking');
  const focused = useIsFocused();
  const bypassed = useRef(!focused);
  useEffect(() => {
    let alive = true; let linked = false;
    const listener = Linking.addEventListener('url', () => { linked = true; if (alive) setState('done'); });
    void Linking.getInitialURL().then((url) => welcomeStore.shouldWelcome(url)).then((show) => {
      if (alive && !linked) setState(show && !bypassed.current ? 'welcome' : 'done');
    }).catch(() => { if (alive) setState('done'); });
    return () => { alive = false; listener.remove(); };
  }, []);
  // A launch into another tab can leave Discover mounted behind it. Never show welcome on return.
  useEffect(() => { if (!focused) bypassed.current = true; }, [focused]);
  if (state === 'checking') return <View style={styles.loading}><ActivityIndicator color={colors.primary} accessibilityLabel="Opening Pickly" /></View>;
  if (state === 'welcome') return <Redirect href="/welcome" />;
  return children;
}

export function WelcomeRoute() {
  const choose = (choice: WelcomeChoice) => {
    welcomeStore.complete();
    if (choice === 'owner') router.replace({ pathname: welcomeDestination(choice), params: { welcome: 'owner' } });
    else router.replace(welcomeDestination(choice));
  };
  return <WelcomeScreen onChoose={choose} />;
}

function WelcomeScreen({ onChoose }: { onChoose: (choice: WelcomeChoice) => void }) {
  const { width, height } = useWindowDimensions();
  const mascotSize = Math.max(140, Math.min(300, height * 0.36, (width - 48) / 0.9));
  return <SafeAreaView style={styles.screen}>
    <ScrollView contentContainerStyle={styles.scroll} bounces={false}>
      <View style={styles.content}>
        <View style={styles.hero}>
          <View style={styles.bubble}><Text style={styles.speech}>Hi there! Let’s get you on a court.</Text></View>
          <PicklyMascot pose="wave" size={mascotSize} />
        </View>
        <View style={styles.introduction}>
          <Text accessibilityRole="header" style={styles.title}>Welcome to Pickly</Text>
          <Text style={styles.description}>Find open courts near you, or manage your own.</Text>
        </View>
        <View style={styles.actions}>
          <Button label="I’m a player" onPress={() => onChoose('player')} accessibilityHint="Explore courts without signing in." />
          <Button label="I own a court" variant="secondary" style={styles.ownerButton} onPress={() => onChoose('owner')}
            accessibilityHint="Sign in to add or claim a venue. Ownership is verified by Pickly." />
        </View>
      </View>
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  screen: { flex: 1, backgroundColor: colors.surface },
  scroll: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 24, paddingTop: 24, paddingBottom: 24 },
  content: { flexGrow: 1, width: '100%', maxWidth: 560, gap: 24 },
  hero: { alignItems: 'center', gap: 12 },
  bubble: { backgroundColor: colors.primary, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 18, borderBottomLeftRadius: 4 },
  speech: { fontFamily: fonts.medium, color: colors.onPrimary, fontSize: 18, lineHeight: 25 },
  introduction: { flexGrow: 1, justifyContent: 'center', gap: 12, paddingVertical: 12 },
  title: { fontFamily: fonts.extrabold, fontSize: 36, lineHeight: 43, letterSpacing: -1.08, textAlign: 'center', color: colors.primary },
  description: { fontFamily: fonts.medium, fontSize: 18, lineHeight: 26, textAlign: 'center', color: colors.textSecondary },
  actions: { gap: 12 },
  ownerButton: { backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.primary },
});
