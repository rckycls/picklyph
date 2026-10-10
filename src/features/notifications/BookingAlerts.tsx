import { AUDIENCE_TOPICS, type NotificationTopic } from '@picklyph/domain';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, Linking, StyleSheet, Switch, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Notice } from '@/components/ui/Notice';
import { screenText } from '@/components/ui/Screen';
import { useAuth } from '@/features/auth/AuthProvider';
import { SignInForm } from '@/features/auth/SignInForm';
import { useOwnerMode } from '@/features/owner/OwnerMode';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { bookingAlertsLabel, createPreferencesWriter, preferencesFailureMessage, TOPIC_COPY, type PushFailure, type PushState } from './pushClient';
import { alertPreferences, syncThisDevice } from './pushLive';

/** Account → Settings → Booking alerts (T45): this phone's permission, and the account's switches. */
export function BookingAlerts() {
  const auth = useAuth();
  if (auth.status === 'restoring') return <OwnerScreen><ActivityIndicator color={colors.primary} accessibilityLabel="Restoring sign-in" /></OwnerScreen>;
  if (auth.status !== 'ready' || !auth.session) return (
    <OwnerScreen>
      <Text accessibilityRole="header" style={screenText.title}>Sign in to choose booking alerts.</Text>
      <Text style={screenText.body}>Alerts belong to your account. You can browse and book without them.</Text>
      <SignInForm />
    </OwnerScreen>
  );
  return <AlertSettings key={auth.session.user.id} actor={auth.session.user.id} />;
}

function AlertSettings({ actor }: { actor: string }) {
  return (
    <OwnerScreen>
      <ThisPhone actor={actor} />
      <Topics actor={actor} />
    </OwnerScreen>
  );
}

/** Explains alerts before iOS asks; after a denial, only Settings can turn them back on. */
function ThisPhone({ actor }: { actor: string }) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => {
    let active = true;
    void syncThisDevice(actor, false).then((next) => { if (active) setState(next); }).catch(() => undefined);
    return () => { active = false; };
  }, [actor]);
  useFocusEffect(read);
  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => { if (next === 'active') read(); });
    return () => listener.remove();
  }, [read]);
  const turnOn = () => {
    setBusy(true);
    void syncThisDevice(actor, true).then(setState).catch(() => undefined).finally(() => setBusy(false));
  };
  const settings = () => void Linking.openSettings().catch(() => undefined);

  return (
    <Card>
      <Text accessibilityRole="header" style={styles.heading}>This phone</Text>
      <Text style={styles.status} accessibilityLiveRegion="polite">{bookingAlertsLabel(state)}</Text>
      {state?.permission === 'undetermined' && <>
        <Text style={screenText.body}>
          Booking alerts are pushes about your bookings: when a venue answers your request, about an hour before you play, and when a
          venue records your payment. Court owners also hear about new requests, bookings and cancellations.
        </Text>
        <Text style={screenText.body}>Booking works the same without them, and the Bookings tab always shows the latest.</Text>
        <Button label="Turn on booking alerts" loading={busy} onPress={turnOn} />
        <Text style={styles.note}>Your iPhone asks next. You can change this any time in iPhone Settings.</Text>
      </>}
      {state?.permission === 'denied' && <>
        <Text style={screenText.body}>
          Notifications for pickly are off in iPhone Settings. Booking still works: the Bookings tab and your venues’ requests always
          show the latest.
        </Text>
        <Button label="Open iPhone Settings" variant="secondary" onPress={settings} />
      </>}
      {state?.permission === 'unavailable' && (
        <Text style={screenText.body}>This version of the app can’t receive alerts yet. Booking still works, and the Bookings tab shows the latest.</Text>
      )}
      {state?.status === 'failed' && <Button label="Try again" variant="secondary" loading={busy} onPress={turnOn} />}
    </Card>
  );
}

type Loaded = { status: 'loading' } | { status: 'failed'; failure: PushFailure } | { status: 'ready'; saved: NotificationTopic[]; shown: NotificationTopic[] };

/** Account-wide switches: every phone of the account follows them. */
function Topics({ actor }: { actor: string }) {
  const { count } = useOwnerMode();
  const service = useMemo(() => alertPreferences(actor), [actor]);
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [message, setMessage] = useState<string | null>(null);
  const fetchSaved = useCallback((signal?: AbortSignal) => service.read(signal).then((outcome) => {
    if (signal?.aborted) return;
    setLoaded(outcome.ok ? { status: 'ready', saved: outcome.value.muted, shown: outcome.value.muted } : { status: 'failed', failure: outcome.failure });
  }).catch(() => undefined), [service]);
  useEffect(() => {
    const abort = new AbortController();
    void fetchSaved(abort.signal);
    return () => abort.abort();
  }, [fetchSaved]);
  const retry = () => { setLoaded({ status: 'loading' }); void fetchSaved(); };
  // The server's answer to the newest change wins; a failure puts the switches back to the last saved set.
  const writer = useMemo(() => createPreferencesWriter(service.save, (outcome) => {
    if (outcome.ok) { setLoaded({ status: 'ready', saved: outcome.value.muted, shown: outcome.value.muted }); return; }
    setLoaded((current) => current.status === 'ready' ? { ...current, shown: current.saved } : current);
    setMessage(preferencesFailureMessage(outcome.failure));
  }), [service]);

  if (loaded.status === 'loading') return (
    <Card><View style={styles.row} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.primary} accessible={false} /><Text style={screenText.body}>Loading your alert choices…</Text>
    </View></Card>
  );
  if (loaded.status === 'failed') return (
    <Card>
      <Notice text={preferencesFailureMessage(loaded.failure)} tone="error" />
      <Button label="Try again" variant="secondary" onPress={retry} />
    </Card>
  );
  const { shown } = loaded;
  const toggle = (topic: NotificationTopic, on: boolean) => {
    const next = on ? shown.filter((item) => item !== topic) : [...shown, topic];
    setMessage(null);
    setLoaded({ ...loaded, shown: next });
    writer.write(next);
  };
  const owner = (count ?? 0) > 0 || AUDIENCE_TOPICS.owner.some((topic) => shown.includes(topic));
  const group = (title: string, topics: readonly NotificationTopic[]) => (
    <View style={styles.group}>
      <Text accessibilityRole="header" style={styles.groupTitle}>{title}</Text>
      {topics.map((topic) => (
        <View key={topic} style={styles.toggle}>
          <View style={styles.grow}>
            <Text style={screenText.label}>{TOPIC_COPY[topic].title}</Text>
            <Text style={styles.note}>{TOPIC_COPY[topic].detail}</Text>
          </View>
          <Switch value={!shown.includes(topic)} onValueChange={(on) => toggle(topic, on)} accessibilityLabel={TOPIC_COPY[topic].title}
            accessibilityHint={TOPIC_COPY[topic].detail} trackColor={{ true: colors.secondary, false: colors.border }} ios_backgroundColor={colors.border} />
        </View>
      ))}
    </View>
  );
  return (
    <Card>
      <Text accessibilityRole="header" style={styles.heading}>What to send</Text>
      <Text style={screenText.body}>These choices apply to every phone signed in to your account. A change applies to new alerts.</Text>
      {group('Your bookings', AUDIENCE_TOPICS.player)}
      {owner && group('Your venues', AUDIENCE_TOPICS.owner)}
      {message && <Notice text={message} tone="error" />}
    </Card>
  );
}

const styles = StyleSheet.create({
  heading: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 19, lineHeight: 25 },
  status: { fontFamily: fonts.semibold, color: colors.text, fontSize: 15, lineHeight: 22 },
  note: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  group: { gap: 12 },
  groupTitle: { fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 13, lineHeight: 18, letterSpacing: 0.4 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1, gap: 2 },
});
