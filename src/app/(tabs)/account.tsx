import Constants from 'expo-constants';
import { useLocalSearchParams } from 'expo-router';
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MenuGroup, MenuRow } from '@/features/account/Menu';
import { ProfileHero } from '@/features/account/ProfileHero';
import { SignedInProfile } from '@/features/account/SignedInProfile';
import { SignInForm } from '@/features/auth/SignInForm';
import { useAuth } from '@/features/auth/AuthProvider';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

export default function AccountScreen() {
  const { welcome } = useLocalSearchParams<{ welcome?: string }>();
  const auth = useAuth();
  const session = auth.status === 'ready' ? auth.session : null;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.content}>
            <View style={styles.header}>
              <Text accessibilityRole="header" style={styles.title}>Account</Text>
              <Text style={styles.country}>PH</Text>
            </View>
            {welcome === 'owner' && <View style={styles.ownerIntroduction}>
              <Text accessibilityRole="header" style={styles.ownerTitle}>Let’s get your court on Pickly.</Text>
              <Text style={styles.ownerDescription}>{session
                ? 'Add a missing venue below, or find your existing listing on Discover to claim it.'
                : 'Sign in below, then add a missing venue or claim your existing listing on Discover.'} A Pickly reviewer verifies ownership before you can manage a venue.</Text>
            </View>}
            {session ? <SignedInProfile key={session.user.id} session={session} /> : <GuestProfile restoring={auth.status === 'restoring'} />}
            <View style={styles.footer} accessible accessibilityLabel={`pickly, version ${Constants.expoConfig?.version ?? 'unknown'}`}>
              <Image source={require('../../../assets/brand/mark-small.png')} style={styles.mark} resizeMode="contain" />
              <Text style={styles.footerText}>pickly · v{Constants.expoConfig?.version ?? '–'}</Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function GuestProfile({ restoring }: { restoring: boolean }) {
  return (
    <>
      <ProfileHero name={restoring ? null : 'Guest player'} initials=""
        detail={restoring ? 'Restoring your sign-in…' : 'You’re browsing courts without an account.'} />
      <SignInForm />
      <MenuGroup title="Own or manage a court?">
        <MenuRow icon="flag" tone="lime" title="Add or claim your venue"
          subtitle="Sign in with the account you’ll use to manage it. A pickly reviewer checks every submission before anything changes." />
      </MenuGroup>
    </>
  );
}

const styles = StyleSheet.create({
  ownerIntroduction: { gap: 8, backgroundColor: colors.selectedBackground, borderRadius: 18, padding: 18 },
  ownerTitle: { fontFamily: fonts.extrabold, color: colors.primary, fontSize: 22, lineHeight: 29 },
  ownerDescription: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 15, lineHeight: 23 },
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, alignItems: 'center' },
  content: { width: '100%', maxWidth: 560, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32, gap: 22 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 34, lineHeight: 40, letterSpacing: -1.2 },
  country: { fontFamily: fonts.semibold, color: colors.brandGreen, backgroundColor: colors.successBackground, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, fontSize: 12, letterSpacing: 1.5, overflow: 'hidden' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 4 },
  mark: { width: 12, height: 18, tintColor: colors.textSecondary },
  footerText: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
});
