import Constants from 'expo-constants';
import { useLocalSearchParams } from 'expo-router';
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PageHeader, pageLayout } from '@/components/ui/PageHeader';

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
          <View style={[pageLayout.content, styles.content]}>
            <PageHeader title="Account" />
            {welcome === 'owner' && <View style={styles.ownerIntroduction}>
              <Text accessibilityRole="header" style={styles.ownerTitle}>Let’s get your court on Pickly.</Text>
              <Text style={styles.ownerDescription}>{session
                ? 'You’re in Owner mode. Add your venue below, or find your existing listing on Discover to claim it.'
                : 'Sign in below. Then, in Owner mode, add your venue or claim your existing listing on Discover.'} A Pickly reviewer checks your proof before players can see or book it.</Text>
            </View>}
            {session
              ? <SignedInProfile key={session.user.id} session={session} startInOwnerMode={welcome === 'owner'} />
              : <GuestProfile restoring={auth.status === 'restoring'} />}
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
        <MenuRow icon="flag" tone="lime" title="Sign in, then switch to Owner"
          subtitle="Use the account you’ll manage your venue with. Owner mode is where you add or claim it; a pickly reviewer checks every request." />
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
  content: { paddingBottom: 32, gap: 22 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 4 },
  mark: { width: 12, height: 18, tintColor: colors.textSecondary },
  footerText: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
});
