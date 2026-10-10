import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { dismissNudge, loadNudgeDismissed } from './nudgeStore';
import { showAlertsNudge, type AlertPermission } from './pushClient';
import { alertPermission, syncThisDevice } from './pushLive';

const COPY = {
  player: {
    title: 'Want a heads-up?',
    body: 'Turn on booking alerts to hear when the venue answers and to get a reminder an hour before you play. Your booking works the same without them, and this screen always shows the latest.',
  },
  owner: {
    title: 'Hear about new requests',
    body: 'Turn on booking alerts to get a push when a player asks to book, so you can answer before the hold runs out. Requests always show here too.',
  },
} as const;

/**
 * A soft ask on booking screens (T45). It explains alerts before iOS asks, and appears only while iOS
 * has never asked on this phone. "Not now" hides it here for good; Account → Booking alerts stays.
 */
export function AlertsNudge({ actor, audience }: { actor: string; audience: keyof typeof COPY }) {
  const [permission, setPermission] = useState<AlertPermission | null>(null);
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useFocusEffect(useCallback(() => {
    let active = true;
    void loadNudgeDismissed().then((value) => { if (active) setDismissed(value); });
    void alertPermission().then((value) => { if (active) setPermission(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []));
  if (!showAlertsNudge(permission, dismissed)) return null;
  const copy = COPY[audience];
  const turnOn = () => {
    setBusy(true);
    void syncThisDevice(actor, true).then((state) => setPermission(state.permission)).catch(() => undefined).finally(() => setBusy(false));
  };
  const notNow = () => {
    setDismissed(true);
    void dismissNudge().catch(() => undefined);
  };
  return (
    <Card>
      <Text accessibilityRole="header" style={styles.title}>{copy.title}</Text>
      <Text style={screenText.body}>{copy.body}</Text>
      <View style={styles.actions}>
        <Button label="Turn on alerts" loading={busy} onPress={turnOn} style={styles.grow} />
        <Button label="Not now" variant="secondary" disabled={busy} onPress={notNow} style={styles.grow} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 17, lineHeight: 23 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  grow: { flexGrow: 1 },
});
