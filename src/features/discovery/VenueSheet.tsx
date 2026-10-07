import type { VenueSearchItem } from '@picklyph/domain';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/features/auth/AuthProvider';
import { useOwnerMode } from '@/features/owner/OwnerMode';
import { venuePhotoUrl } from '@/lib/venuePhotos';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { loadLiveVenueDetail } from './liveDirectory';
import { NOT_BOOKABLE_CAPTION, courtCount, courtSummary, directionsLinks, listingNotice } from './listing';
import type { VenueDetail } from './venueDetail';

type DetailState = { status: 'loading' } | { status: 'ready'; venue: VenueDetail } | { status: 'missing' } | { status: 'error' };

/**
 * Floating venue card over the bottom of the map or list. Compact by default (name, address,
 * status, directions); courts and listing details expand on request. Search results are a
 * snapshot, so details and directions always use the current public record.
 */
export function VenueSheet({ venue, onClose, onMissing }: { venue: VenueSearchItem; onClose: () => void; onMissing: (id: string) => void }) {
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [linkError, setLinkError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const auth = useAuth();
  const signedIn = auth.status === 'ready' && Boolean(auth.session);
  const { mode } = useOwnerMode();
  // Claiming is an owner action: only signed-in accounts in Owner mode see it.
  const canClaim = signedIn && mode === 'owner';

  // The screen keys this card by venue ID, so each venue starts from a fresh loading state.
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
  const place = current ?? venue;
  const missing = detail.status === 'missing';
  const notice = listingNotice(place.claim_status);
  const open = (url: string) => {
    setLinkError(false);
    void Linking.openURL(url).catch(() => setLinkError(true));
  };

  return (
    <View style={styles.shadow}>
      <View style={styles.card}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} bounces={false}>
          <View style={styles.header}>
            <View style={styles.heading}>
              <Text accessibilityRole="header" numberOfLines={2} style={styles.name}>{place.name}</Text>
              {!missing && (
                <Text numberOfLines={2} style={styles.address}>{place.address_line}, {place.city}, {place.province}</Text>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close venue details"
              hitSlop={6}
              onPress={onClose}
              style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
            >
              <Text style={styles.closeGlyph} accessible={false}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.chips}>
            {missing
              ? <StatusBadge label="No longer listed" tone="error" />
              : <>
                <StatusBadge label={notice.badge} tone={notice.tone} />
                <StatusBadge label={courtCount(current ? current.courts.length : venue.active_court_count)} tone="neutral" />
              </>}
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.caption}>
            {missing ? 'This venue is no longer in the approved directory. It has been removed from your results.'
              : current?.claim_status === 'verified' ? 'Review a court rental below. Availability and price are checked by the server.' : NOT_BOOKABLE_CAPTION}
          </Text>

          {detail.status === 'loading' && (
            <View style={styles.row} accessibilityLiveRegion="polite">
              <ActivityIndicator color={colors.primary} accessible={false} />
              <Text style={styles.caption}>Loading current details…</Text>
            </View>
          )}
          {detail.status === 'error' && (
            <View style={styles.row}>
              <Text accessibilityLiveRegion="polite" style={[styles.caption, styles.grow]}>Couldn’t load the current details.</Text>
              <Button label="Retry" variant="secondary" style={styles.retry} onPress={() => {
                setDetail({ status: 'loading' });
                setAttempt((value) => value + 1);
              }} />
            </View>
          )}

          {current && (
            <>
              {current.claim_status === 'verified' && current.courts.length > 0 && <Button
                label={signedIn ? 'Choose a court & time' : 'Sign in to reserve a court'} variant="accent"
                onPress={() => router.push({ pathname: '/rental/venue/[id]', params: { id: current.id } })} />}
              <View style={styles.actions}>
                <Button
                  label="Apple Maps"
                  accessibilityLabel="Directions in Apple Maps"
                  accessibilityHint="Opens Apple Maps with this venue as the destination."
                  style={styles.action}
                  onPress={() => open(directionsLinks(current.latitude, current.longitude).apple)}
                />
                <Button
                  label="Google Maps"
                  variant="accent"
                  accessibilityLabel="Directions in Google Maps"
                  accessibilityHint="Opens Google Maps with this venue as the destination."
                  style={styles.action}
                  onPress={() => open(directionsLinks(current.latitude, current.longitude).google)}
                />
              </View>
              {linkError && <Text accessibilityLiveRegion="polite" style={styles.error}>Couldn’t open Maps on this device.</Text>}

              <View style={styles.footer}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  accessibilityLabel={expanded ? 'Hide courts and listing details' : 'Show courts and listing details'}
                  onPress={() => setExpanded((value) => !value)}
                  style={({ pressed }) => [styles.link, pressed && styles.linkPressed]}
                >
                  <Text style={styles.linkText}>{expanded ? 'Hide courts' : 'Show courts'} {expanded ? '▴' : '▾'}</Text>
                </Pressable>
                {canClaim && current.claim_status !== 'verified' && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityHint="A pickly reviewer checks your proof before anything changes."
                    onPress={() => router.push({ pathname: '/owner/claim/[id]', params: { id: current.id } })}
                    style={({ pressed }) => [styles.link, pressed && styles.linkPressed]}
                  >
                    <Text style={styles.linkText}>Claim this venue</Text>
                  </Pressable>
                )}
              </View>

              {expanded && (
                <View style={styles.details}>
                  {current.photos.length > 0 && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photos}>
                      {current.photos.map((photo, index) => (
                        <Image key={photo.id} source={{ uri: venuePhotoUrl(photo.storage_path) }} resizeMode="cover"
                          style={styles.photo} accessible accessibilityLabel={`${current.name}, photo ${index + 1} of ${current.photos.length}`} />
                      ))}
                    </ScrollView>
                  )}
                  {current.courts.length === 0
                    ? <Text style={styles.caption}>No active courts are listed for this venue.</Text>
                    : current.courts.map((court) => (
                      <Text key={court.id} style={styles.court}>
                        <Text style={styles.courtName}>{court.name}</Text> · {courtSummary(court)}
                      </Text>
                    ))}
                  <Text style={styles.caption}>{notice.text}</Text>
                </View>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Outer view casts the shadow; the inner one clips the rounded corners (iOS drops shadows on clipped views).
  shadow: {
    position: 'absolute', left: 12, right: 12, bottom: 12, maxHeight: '88%', borderRadius: 20,
    shadowColor: '#101820', shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  card: { flexShrink: 1, borderRadius: 20, overflow: 'hidden', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  scroll: { flexGrow: 0 },
  content: { padding: 16, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  heading: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.extrabold, color: colors.text, fontSize: 20, lineHeight: 26, letterSpacing: -0.3 },
  address: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  close: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.selectedBackground, marginTop: -2, marginRight: -4 },
  closePressed: { opacity: 0.7 },
  closeGlyph: { fontFamily: fonts.semibold, color: colors.text, fontSize: 15, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  caption: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  grow: { flex: 1 },
  retry: { minHeight: 40, paddingHorizontal: 16 },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1, paddingHorizontal: 8 },
  error: { fontFamily: fonts.medium, color: colors.error, fontSize: 13, lineHeight: 19 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginHorizontal: -8, marginBottom: -6 },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, borderRadius: 10 },
  linkPressed: { backgroundColor: colors.selectedBackground },
  linkText: { fontFamily: fonts.semibold, color: colors.link, fontSize: 14, lineHeight: 20 },
  details: { gap: 6, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  photos: { gap: 8, paddingVertical: 4 },
  photo: { width: 220, height: 165, borderRadius: 12, backgroundColor: colors.selectedBackground },
  court: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  courtName: { fontFamily: fonts.semibold, color: colors.text },
});
