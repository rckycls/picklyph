import type { OwnedVenueSummary } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CourtArtwork } from '@/components/ui/CourtArtwork';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { screenText } from '@/components/ui/Screen';
import { liveOwnedVenues } from '@/features/owner/liveOwner';
import { VerifiedOwnerGate } from '@/features/owner/OwnerMode';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { VenueCard } from '@/features/owner/VenueCard';
import { venueFailureMessage } from '@/features/owner/venueClient';
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
    // Keep the last list on screen while it refreshes, so returning from a tool doesn't flash.
    setVenues((current) => (current.status === 'ready' ? current : { status: 'loading' }));
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
      {includeTop && <PageHeader title="Venues" />}
      <Text style={styles.intro}>Run each court’s calendar and front desk, answer requests, and keep hours and details current.</Text>
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
          <CourtArtwork />
          <Text style={screenText.title}>Bring your courts to pickly.</Text>
          <Text style={screenText.body}>
            You don’t manage a venue yet. Add your venue, or open your listing on Discover and tap Claim. pickly reviews every request.
          </Text>
          <Button label="Add your venue" onPress={() => router.push('/owner/submit')} />
          <Button label="Find your listing on Discover" variant="secondary" onPress={() => router.navigate('/(tabs)')} />
        </Card>
      )}
      {venues.status === 'ready' && venues.items.map((venue) => <VenueCard key={venue.id} venue={venue} />)}
      {venues.status === 'ready' && venues.items.length > 0 && (
        <Pressable accessibilityRole="button" accessibilityLabel="Add another venue" onPress={() => router.push('/owner/submit')}
          style={({ pressed }) => [styles.add, pressed && styles.pressed]}>
          <View style={styles.addIcon}><Icon name="plus" color={colors.primary} size={20} /></View>
          <Text style={styles.addText}>Add another venue</Text>
        </Pressable>
      )}
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  intro: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 15, lineHeight: 22, marginTop: -8 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  add: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56, borderRadius: 20,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.border, paddingHorizontal: 16 },
  addIcon: { width: 32, height: 32, borderRadius: 11, backgroundColor: colors.selectedBackground, alignItems: 'center', justifyContent: 'center' },
  addText: { fontFamily: fonts.semibold, color: colors.text, fontSize: 15, lineHeight: 21 },
  pressed: { backgroundColor: colors.surface },
});
