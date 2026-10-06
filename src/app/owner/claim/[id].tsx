import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { listingNotice } from '@/features/discovery/listing';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { EvidencePicker } from '@/features/owner/EvidencePicker';
import { liveSubmit } from '@/features/owner/liveOwner';
import { ownerFailureMessage, type EvidenceFile } from '@/features/owner/ownerClient';
import { claimRequest } from '@/features/owner/ownerForm';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { colors } from '@/theme/colors';

type Listing = { status: 'loading' } | { status: 'ready'; venue: VenueDetail } | { status: 'missing' } | { status: 'error' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ClaimScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const venueId = typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
  const [listing, setListing] = useState<Listing>(venueId ? { status: 'loading' } : { status: 'missing' });
  const [attempt, setAttempt] = useState(0);
  const [evidence, setEvidence] = useState<EvidenceFile | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // One request ID per claim attempt, so a retry after a dropped connection cannot create a second claim.
  const requestId = useRef(randomUUID());

  useEffect(() => {
    if (!venueId) return;
    const abort = new AbortController();
    loadLiveVenueDetail(venueId, abort.signal).then((venue) => {
      if (!abort.signal.aborted) setListing(venue ? { status: 'ready', venue } : { status: 'missing' });
    }, () => { if (!abort.signal.aborted) setListing({ status: 'error' }); });
    return () => abort.abort();
  }, [venueId, attempt]);

  const submit = async () => {
    if (!venueId || !evidence) { setMessage('Add a photo that shows you own or manage this venue.'); return; }
    const built = claimRequest(venueId, note, requestId.current);
    if (!built.ok) { setMessage(built.message); return; }
    setBusy(true); setMessage(null);
    const outcome = await liveSubmit(built.request, evidence);
    setBusy(false);
    if (outcome.ok && outcome.value.status !== 'duplicates') setDone(true);
    else setMessage(outcome.ok ? 'This claim couldn’t be submitted. Try again.' : ownerFailureMessage(outcome.failure));
  };

  if (done) {
    return (
      <OwnerScreen>
        <Card tone="highlight">
          <StatusBadge label="Claim under review" tone="pending" />
          <Text accessibilityRole="header" style={screenText.title}>Claim submitted.</Text>
          <Text accessibilityLiveRegion="polite" style={screenText.body}>
            A pickly reviewer will check your proof. The listing doesn’t change, and you can’t manage it, until the claim is approved.
          </Text>
          <Button label="View your submissions" onPress={() => router.navigate('/account')} />
          <Button label="Back to Discover" variant="secondary" onPress={() => router.navigate('/')} />
        </Card>
      </OwnerScreen>
    );
  }
  return (
    <OwnerScreen>
      {listing.status === 'loading' && (
        <View accessibilityLiveRegion="polite" style={styles.row}>
          <ActivityIndicator color={colors.primary} accessible={false} />
          <Text style={screenText.body}>Loading the current listing…</Text>
        </View>
      )}
      {listing.status === 'error' && (
        <Card>
          <Text accessibilityRole="alert" style={screenText.body}>Couldn’t load this listing. Check your connection and try again.</Text>
          <Button label="Try again" variant="secondary" onPress={() => { setListing({ status: 'loading' }); setAttempt((value) => value + 1); }} />
        </Card>
      )}
      {listing.status === 'missing' && (
        <Card>
          <StatusBadge label="No longer listed" tone="error" />
          <Text style={screenText.body}>This venue isn’t in the approved directory, so it can’t be claimed. You can add it as a missing venue instead.</Text>
          <Button label="Add a missing venue" onPress={() => router.replace('/owner/submit')} />
        </Card>
      )}
      {listing.status === 'ready' && (
        <>
          <Card>
            <StatusBadge label={listingNotice(listing.venue.claim_status).badge} tone={listingNotice(listing.venue.claim_status).tone} />
            <Text accessibilityRole="header" style={screenText.title}>{listing.venue.name}</Text>
            <Text style={screenText.body}>{listing.venue.address_line}, {listing.venue.city}, {listing.venue.province}</Text>
          </Card>
          {listing.venue.claim_status === 'verified' ? (
            <Card>
              <Text style={screenText.body}>This listing already has a verified owner. Contact pickly support if you also manage it.</Text>
            </Card>
          ) : (
            <Card>
              <Text style={screenText.body}>
                Claiming asks pickly to confirm you own or manage this venue. Reviewers see your proof and account email; players never do.
              </Text>
              <EvidencePicker value={evidence} onChange={setEvidence} disabled={busy} />
              <Field label="Anything reviewers should know (optional)" value={note} onChangeText={setNote} multiline maxLength={500}
                hint="For example, your role at the venue." style={styles.note} editable={!busy} />
              {message && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>}
              <Button label="Submit claim for review" loading={busy} onPress={() => void submit()} />
            </Card>
          )}
        </>
      )}
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  note: { minHeight: 96, textAlignVertical: 'top' },
  error: { color: colors.error, fontSize: 15, lineHeight: 22 },
});
