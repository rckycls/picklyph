import type { VenueSearchItem } from '@picklyph/domain';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Button } from '@/components/ui/Button';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/features/auth/AuthProvider';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { loadLiveVenueDetail } from './liveDirectory';
import { courtSummary, directionsLinks, listingNotice } from './listing';
import type { VenueDetail } from './venueDetail';

type DetailState = { status: 'loading' } | { status: 'ready'; venue: VenueDetail } | { status: 'missing' } | { status: 'error' };

/** Search results are a snapshot; details and directions always use the current public record. */
export function VenueSheet({ venue, onClose, onMissing }: { venue: VenueSearchItem; onClose: () => void; onMissing: (id: string) => void }) {
  const { height } = useWindowDimensions();
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [linkError, setLinkError] = useState(false);
  const auth = useAuth();
  const signedIn = auth.status === 'ready' && Boolean(auth.session);

  // The screen keys this sheet by venue ID, so each venue starts from a fresh loading state.
  useEffect(() => {
    const abort = new AbortController();
    loadLiveVenueDetail(venue.id, abort.signal).then((record) => {
      if (abort.signal.aborted) return;
      setDetail(record ? { status: 'ready', venue: record } : { status: 'missing' });
      if (!record) onMissing(venue.id);
    }, () => { if (!abort.signal.aborted) setDetail({ status: 'error' }); });
    return () => abort.abort();
  }, [venue.id, attempt, onMissing]);

  const current = detail.status === 'ready' ? detail.venue : null;
  const notice = listingNotice(current?.claim_status ?? venue.claim_status);
  const open = (url: string) => {
    setLinkError(false);
    void Linking.openURL(url).catch(() => setLinkError(true));
  };

  return (
    <View style={[styles.sheet, { maxHeight: height * 0.4 }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.badges}>
          {detail.status === 'missing'
            ? <StatusBadge label="No longer listed" tone="error" />
            : <StatusBadge label={notice.badge} tone={notice.tone} />}
          <StatusBadge label="Not bookable in pickly" tone="neutral" />
        </View>
        <Text accessibilityRole="header" style={screenText.title}>{current?.name ?? venue.name}</Text>
        {detail.status === 'missing' ? (
          <Text accessibilityLiveRegion="polite" style={screenText.body}>
            This venue is no longer in the approved directory. It has been removed from your results.
          </Text>
        ) : (
          <>
            <Text style={screenText.body}>
              {(current ?? venue).address_line}, {(current ?? venue).city}, {(current ?? venue).province}
            </Text>
            <Text style={screenText.body}>{notice.text}</Text>
          </>
        )}
        {detail.status === 'loading' && (
          <View style={styles.row} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.primary} accessible={false} />
            <Text style={screenText.body}>Loading current venue details…</Text>
          </View>
        )}
        {detail.status === 'error' && (
          <View style={styles.group}>
            <Text accessibilityLiveRegion="polite" style={screenText.body}>
              Couldn’t load the current venue details. Directions are available once they load.
            </Text>
            <Button label="Retry details" variant="secondary" onPress={() => {
              setDetail({ status: 'loading' });
              setAttempt((value) => value + 1);
            }} />
          </View>
        )}
        {current && (
          <>
            <View style={styles.group}>
              <Text style={screenText.label}>Active courts</Text>
              {current.courts.length === 0
                ? <Text style={screenText.body}>No active courts are listed for this venue.</Text>
                : current.courts.map((court) => (
                  <Text key={court.id} style={styles.court}>
                    <Text style={styles.courtName}>{court.name}</Text> · {courtSummary(court)}
                  </Text>
                ))}
            </View>
            <View style={styles.actions}>
              <Button
                label="Directions in Apple Maps"
                style={styles.action}
                accessibilityHint="Opens Apple Maps with this venue as the destination."
                onPress={() => open(directionsLinks(current.latitude, current.longitude).apple)}
              />
              <Button
                label="Directions in Google Maps"
                variant="accent"
                style={styles.action}
                accessibilityHint="Opens Google Maps with this venue as the destination."
                onPress={() => open(directionsLinks(current.latitude, current.longitude).google)}
              />
            </View>
            {linkError && <Text accessibilityLiveRegion="polite" style={styles.error}>Couldn’t open Maps on this device.</Text>}
            {current.claim_status !== 'verified' && (
              <Button
                label={signedIn ? 'Own this venue? Claim it' : 'Own this venue? Sign in to claim it'}
                variant="secondary"
                accessibilityHint="A pickly reviewer checks your proof before anything changes."
                onPress={() => (signedIn ? router.push({ pathname: '/owner/claim/[id]', params: { id: current.id } }) : router.navigate('/account'))}
              />
            )}
          </>
        )}
        <Button label="Close details" variant="secondary" onPress={onClose} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
  content: { padding: 20, gap: 12 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  group: { gap: 8 },
  court: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
  courtName: { fontFamily: fonts.semibold, color: colors.text },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flexGrow: 1, flexBasis: 200 },
  error: { fontFamily: fonts.medium, color: colors.error, fontSize: 14, lineHeight: 21 },
});
