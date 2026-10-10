import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { appleAuthorizationCode } from '@/features/auth/apple';
import { useAuth } from '@/features/auth/AuthProvider';
import { SignInForm } from '@/features/auth/SignInForm';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { CONFIRM_WORD, confirmationTyped, deleteAccountConfirmed, deletionAttemptMessage, usesAppleSignIn } from './deletionClient';
import { accountDeletionServices } from './deletionLive';

const APPLE_CONSEQUENCE = 'You use Sign in with Apple, so Apple asks you to confirm. pickly then stops using your Apple ID and disappears from the apps listed under Sign in with Apple in your Apple ID settings.';
const CONSEQUENCES = [
  'Your profile, name, mobile number, email sign-in and photo are deleted.',
  'Upcoming court rentals and open-play groups are cancelled. Bookings that already started stay as they are.',
  'If you manage venues, they’re released. A listing with no other owner stops taking new bookings; bookings players already made stay.',
  'Ownership claims, proof photos and venue drafts still in review are removed.',
  'Venues keep their records of past bookings (date, court, price and any payment recorded at the desk) without your name. Group names you entered become “Guest 1”, “Guest 2”.',
  'This can’t be undone. Signing in again later starts a new, empty account.',
];

/** Account deletion (T47). The finished state lives here, above the auth switch, so it survives the sign-out it causes. */
export function DeleteAccount() {
  const auth = useAuth();
  const [finished, setFinished] = useState<{ deviceCleared: boolean } | null>(null);
  if (finished) return <Deleted deviceCleared={finished.deviceCleared} />;
  if (auth.status === 'restoring') return <OwnerScreen><ActivityIndicator color={colors.primary} accessibilityLabel="Restoring sign-in" /></OwnerScreen>;
  if (auth.status !== 'ready' || !auth.session) return (
    <OwnerScreen>
      <Text accessibilityRole="header" style={screenText.title}>Sign in to delete your account.</Text>
      <Text style={screenText.body}>Sign in with the account you want to delete, then come back to this screen.</Text>
      <SignInForm />
    </OwnerScreen>
  );
  return <DeleteForm key={auth.session.user.id} actor={auth.session.user.id} appleLinked={usesAppleSignIn(auth.session.user)} onDeleted={setFinished} />;
}

function DeleteForm({ actor, appleLinked, onDeleted }: { actor: string; appleLinked: boolean; onDeleted: (result: { deviceCleared: boolean }) => void }) {
  const auth = useAuth();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const ready = confirmationTyped(typed);
  const consequences = appleLinked ? [...CONSEQUENCES.slice(0, -1), APPLE_CONSEQUENCE, ...CONSEQUENCES.slice(-1)] : CONSEQUENCES;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setMessage(null);
    const services = accountDeletionServices(actor);
    // Apple's sheet opens only now, after DELETE is typed and the button tapped (T50a).
    const outcome = await deleteAccountConfirmed(services.transport, appleLinked, appleAuthorizationCode);
    if (!outcome.ok) { setBusy(false); setMessage(deletionAttemptMessage(outcome)); return; }
    // Only now, with the account confirmed gone, may this phone forget its uncertain requests.
    let deviceCleared = true;
    try { await services.clearDevice(); } catch { deviceCleared = false; }
    onDeleted({ deviceCleared });
    try { await auth.signOut(); } catch { await auth.clearSaved().catch(() => undefined); }
  };

  return (
    <OwnerScreen>
      <Card>
        <Text accessibilityRole="header" style={screenText.title}>Delete your pickly account</Text>
        <View style={styles.list}>
          {consequences.map((line) => (
            <View key={line} style={styles.item}>
              <View style={styles.bullet} accessible={false} />
              <Text style={[screenText.body, styles.itemText]}>{line}</Text>
            </View>
          ))}
        </View>
      </Card>
      <Card>
        <Field label={`Type ${CONFIRM_WORD} to confirm`} value={typed} onChangeText={setTyped} autoCapitalize="characters" autoCorrect={false}
          autoComplete="off" editable={!busy} returnKeyType="done" onSubmitEditing={() => void submit()} />
        {message && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>}
        <Button label={appleLinked ? 'Continue with Apple and delete' : 'Delete my account'} loading={busy} disabled={!ready} onPress={() => void submit()} />
        <Button label="Keep my account" variant="secondary" disabled={busy} onPress={() => router.back()} />
      </Card>
    </OwnerScreen>
  );
}

function Deleted({ deviceCleared }: { deviceCleared: boolean }) {
  return (
    <OwnerScreen>
      <Card tone="highlight">
        <StatusBadge label="Account deleted" tone="success" />
        <Text accessibilityRole="header" style={screenText.title}>Your account is deleted.</Text>
        <Text accessibilityLiveRegion="polite" style={screenText.body}>
          Thanks for playing with pickly. You’re signed out on this phone, and you can keep browsing courts as a guest.
        </Text>
        {!deviceCleared && <Text style={screenText.body}>
          Some saved request details couldn’t be removed from this phone. Deleting the pickly app removes them.
        </Text>}
        <Button label="Back to Discover" onPress={() => router.replace('/(tabs)')} />
      </Card>
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  list: { gap: 10 },
  item: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  bullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary, marginTop: 9 },
  itemText: { flex: 1 },
  error: { fontFamily: fonts.medium, color: colors.error, fontSize: 15, lineHeight: 22 },
});
