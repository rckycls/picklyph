import type { OwnedVenueSummary } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { liveOwnedVenues } from '@/features/owner/liveOwner';
import { VerifiedOwnerGate } from '@/features/owner/OwnerMode';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { venueFailureMessage } from '@/features/owner/venueClient';
import { summaryStatus } from '@/features/owner/venueDraft';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

type Venues = { status: 'loading' } | { status: 'ready'; items: OwnedVenueSummary[] } | { status: 'error'; message: string };

export default function OwnedVenuesRoute() {
  return <VerifiedOwnerGate><OwnedVenuesScreen /></VerifiedOwnerGate>;
}

export function OwnedVenuesScreen({ includeTop = false }: { includeTop?: boolean }) {
  const [venues, setVenues] = useState<Venues>({ status: 'loading' });
  const load = useCallback(() => {
    let active = true;
    setVenues({ status: 'loading' });
    void liveOwnedVenues().then((outcome) => {
      if (!active) return;
      setVenues(outcome.ok ? { status: 'ready', items: outcome.value } : { status: 'error', message: venueFailureMessage(outcome.failure) });
    });
    return () => { active = false; };
  }, []);
  // Refresh on return from the editor, so names and photo counts are current.
  useFocusEffect(load);

  return (
    <OwnerScreen includeTop={includeTop}>
      <Text style={screenText.body}>Venues pickly has verified you manage. Run each court’s calendar, set hours and closures, and edit details, courts and photos.</Text>
      {venues.status === 'loading' && (
        <View style={styles.row} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.primary} accessible={false} />
          <Text style={screenText.body}>Loading your venues…</Text>
        </View>
      )}
      {venues.status === 'error' && (
        <Card>
          <Text accessibilityRole="alert" style={screenText.body}>{venues.message}</Text>
          <Button label="Try again" variant="secondary" onPress={() => { load(); }} />
        </Card>
      )}
      {venues.status === 'ready' && venues.items.length === 0 && (
        <Card>
          <Text style={screenText.body}>
            You don’t manage a venue yet. Claim a listing from Discover, or add a missing venue from Account. pickly reviews every request.
          </Text>
        </Card>
      )}
      {venues.status === 'ready' && venues.items.map((venue) => {
        const status = summaryStatus(venue);
        return (
          <Card key={venue.id}>
            <StatusBadge label={status.label} tone={status.tone} />
            <Text accessibilityRole="header" style={styles.name}>{venue.name}</Text>
            <Text style={screenText.body}>
              {venue.city}, {venue.province} · {venue.active_court_count === 1 ? '1 active court' : `${venue.active_court_count} active courts`} · {venue.photo_count === 1 ? '1 photo' : `${venue.photo_count} photos`}
            </Text>
            {status.note && <Text style={screenText.body}>{status.note}</Text>}
            {venue.editable && <>
              <Button label="Court calendar" accessibilityLabel={`Court calendar for ${venue.name}`}
                onPress={() => router.push({ pathname: '/owner/calendar/[id]', params: { id: venue.id } })} />
              <Button label="Hours and closures" variant="secondary" accessibilityLabel={`Hours and closures for ${venue.name}`}
                onPress={() => router.push({ pathname: '/owner/hours/[id]', params: { id: venue.id } })} />
              <Button label="Edit venue" variant="secondary" accessibilityLabel={`Edit ${venue.name}`}
                onPress={() => router.push({ pathname: '/owner/venues/[id]', params: { id: venue.id } })} />
            </>}
          </Card>
        );
      })}
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  name: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 19, lineHeight: 25 },
});
