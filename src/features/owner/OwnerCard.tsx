import type { OwnerSubmission } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';
import { useAuth } from '@/features/auth/AuthProvider';

import { loadMySubmissions } from './liveOwner';
import { OwnerModeSwitch, useOwnerMode } from './OwnerMode';
import { ownerFailureMessage } from './ownerClient';
import { SubmissionList } from './OwnerLists';

type Submissions = { status: 'loading' } | { status: 'ready'; items: OwnerSubmission[] } | { status: 'error'; message: string };

/** Account-tab entry point for owners: submit a missing venue and follow review status. */
export function OwnerCard({ signedIn }: { signedIn: boolean }) {
  const [submissions, setSubmissions] = useState<Submissions>({ status: 'loading' });
  const { session } = useAuth();
  const identity = session?.user.id ?? null;
  const { count: managed, mode } = useOwnerMode();
  const load = useCallback(() => {
    let active = true;
    setSubmissions({ status: 'loading' });
    void loadMySubmissions().then((outcome) => {
      if (!active) return;
      setSubmissions(outcome.ok ? { status: 'ready', items: outcome.value } : { status: 'error', message: ownerFailureMessage(outcome.failure) });
    });
    return () => { active = false; };
  }, []);
  // Refresh whenever Account regains focus, e.g. after submitting.
  useFocusEffect(useCallback(() => (signedIn && identity ? load() : undefined), [signedIn, identity, load]));

  return (
    <><OwnerModeSwitch /><Card tone="highlight">
      <Text accessibilityRole="header" style={screenText.title}>Own or manage a court?</Text>
      <Text style={screenText.body}>
        Add a venue that isn’t on the map, or claim an existing listing from its details on Discover. A pickly reviewer checks every submission before anything changes.
      </Text>
      {!signedIn ? (
        <>
          <StatusBadge label="Sign in to submit" tone="neutral" />
          <Text style={screenText.body}>Sign in above with the account you’ll use to manage the venue.</Text>
        </>
      ) : (
        <>
          {managed !== null && managed > 0 && mode === 'owner' && (
            <Button label={managed > 1 ? `Manage your ${managed} venues` : 'Manage your venue'} onPress={() => router.push('/owner')} />
          )}
          <Button label="Add a missing venue" variant={managed && managed > 0 ? 'secondary' : 'primary'} onPress={() => router.push('/owner/submit')} />
          <Text accessibilityRole="header" style={screenText.label}>Your submissions</Text>
          {submissions.status === 'loading' && (
            <View style={styles.row} accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.primary} accessible={false} />
              <Text style={screenText.body}>Loading your submissions…</Text>
            </View>
          )}
          {submissions.status === 'error' && (
            <>
              <Text accessibilityLiveRegion="polite" style={screenText.body}>{submissions.message}</Text>
              <Button label="Try again" variant="secondary" onPress={() => { load(); }} />
            </>
          )}
          {submissions.status === 'ready' && (submissions.items.length === 0
            ? <Text style={screenText.body}>You haven’t submitted a venue or claim yet.</Text>
            : <SubmissionList submissions={submissions.items} />)}
        </>
      )}
    </Card></>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
