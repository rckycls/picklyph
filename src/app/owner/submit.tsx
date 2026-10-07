import type { AddressCandidate, OwnerDuplicate, OwnerSubmission } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { MapRegion } from '@/features/discovery/mapTypes';
import { PHILIPPINES_REGION } from '@/features/discovery/region';
import { EvidencePicker } from '@/features/owner/EvidencePicker';
import { liveAddressSearch, liveNearbyListings, liveSubmit } from '@/features/owner/liveOwner';
import { ownerFailureMessage, type EvidenceFile } from '@/features/owner/ownerClient';
import { applyCandidate, EMPTY_DRAFT, pinProblem, venueRequest, type Pin, type VenueDraft } from '@/features/owner/ownerForm';
import { OwnerGate } from '@/features/owner/OwnerGate';
import { DuplicateList } from '@/features/owner/OwnerLists';
import { useOwnerMode } from '@/features/owner/OwnerMode';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import PinMap from '@/features/owner/PinMap';
import { locateUser } from '@/lib/location';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

type Step = 'locate' | 'nearby' | 'details' | 'done';
type Busy = 'search' | 'locate' | 'nearby' | 'submit' | null;

export default function SubmitVenueRoute() {
  return <OwnerGate><SubmitVenueScreen /></OwnerGate>;
}

/** The owner adds their venue: it becomes their private draft at once, published after pickly reviews the proof. */
function SubmitVenueScreen() {
  const owner = useOwnerMode();
  const [created, setCreated] = useState<OwnerSubmission | null>(null);
  const [step, setStep] = useState<Step>('locate');
  const [pin, setPin] = useState<Pin | null>(null);
  const [focus, setFocus] = useState<MapRegion>(PHILIPPINES_REGION);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<AddressCandidate[] | null>(null);
  const [draft, setDraft] = useState<VenueDraft>(EMPTY_DRAFT);
  const [duplicates, setDuplicates] = useState<OwnerDuplicate[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceFile | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Reused for retries of this submission; the server returns the original record instead of a duplicate.
  const requestId = useRef(randomUUID());

  const field = (key: keyof VenueDraft) => (value: string) => setDraft((current) => ({ ...current, [key]: value }));
  // A moved pin needs a fresh duplicate check before it can be acknowledged again.
  const movePin = (next: Pin, zoom: boolean) => {
    setPin({ latitude: next.latitude, longitude: next.longitude });
    setAcknowledged(false);
    if (zoom) setFocus({ latitude: next.latitude, longitude: next.longitude, latitudeDelta: 0.005, longitudeDelta: 0.005 });
  };

  const search = async () => {
    const address = query.trim();
    if (address.length < 3) { setMessage('Enter at least 3 characters of the address.'); return; }
    setBusy('search'); setMessage(null);
    const outcome = await liveAddressSearch(address);
    setBusy(null);
    if (!outcome.ok) { setCandidates(null); setMessage(ownerFailureMessage(outcome.failure)); return; }
    setCandidates(outcome.value);
  };
  const choose = (candidate: AddressCandidate) => {
    movePin(candidate, true);
    setDraft((current) => applyCandidate(current, candidate));
    setCandidates(null);
  };
  const locateHere = async () => {
    setBusy('locate'); setMessage(null);
    const result = await locateUser();
    setBusy(null);
    if (result.status === 'granted') movePin(result.coordinates, true);
    else setMessage(result.status === 'denied' ? 'Location access is off. Search an address or tap the map instead.'
      : 'Couldn’t find your location. Search an address or tap the map instead.');
  };
  const checkNearby = async () => {
    const problem = pinProblem(pin);
    if (problem || !pin) { setMessage(problem); return; }
    setBusy('nearby'); setMessage(null);
    const outcome = await liveNearbyListings(pin, null);
    setBusy(null);
    if (!outcome.ok) { setMessage(ownerFailureMessage(outcome.failure)); return; }
    setDuplicates(outcome.value);
    setStep(outcome.value.length > 0 ? 'nearby' : 'details');
  };
  const submit = async () => {
    if (!evidence) { setMessage('Add a photo that shows you own or manage this venue.'); return; }
    const built = venueRequest(draft, pin, requestId.current, acknowledged);
    if (!built.ok) { setMessage(built.message); return; }
    setBusy('submit'); setMessage(null);
    const outcome = await liveSubmit(built.request, evidence);
    setBusy(null);
    if (!outcome.ok) { setMessage(ownerFailureMessage(outcome.failure)); return; }
    if (outcome.value.status === 'duplicates') {
      // The server found a listing by name or location: confirm before anything is stored.
      setDuplicates(outcome.value.duplicates); setAcknowledged(false); setStep('nearby');
      return;
    }
    setCreated(outcome.value.submission);
    setStep('done');
    // The new draft counts as a venue this account manages, so owner mode can open it.
    owner.refresh();
  };
  const alert = message && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>;

  if (step === 'done') {
    // Servers without owner drafts return no venue; the submission then only awaits review.
    const draftId = created?.venue_id ?? null;
    return (
      <OwnerScreen>
        <Card tone="highlight">
          <StatusBadge label="Venue under review" tone="pending" />
          <Text accessibilityRole="header" style={screenText.title}>{draftId ? 'Your venue is added.' : 'Submitted for review.'}</Text>
          <Text accessibilityLiveRegion="polite" style={screenText.body}>
            {draftId
              ? 'Set up your courts, hours, photos and policies now. A pickly reviewer checks your proof photo, then publishes the venue on Discover.'
              : 'A pickly reviewer will check the location and your proof. Nothing appears on the map until it’s approved.'}
          </Text>
          {draftId && (
            <Button label="Set up your venue" loading={owner.count === null} disabled={!owner.count}
              onPress={() => router.replace({ pathname: '/owner/venues/[id]', params: { id: draftId } })} />
          )}
          <Button label="View your submissions" variant={draftId ? 'secondary' : 'primary'} onPress={() => router.navigate('/account')} />
        </Card>
      </OwnerScreen>
    );
  }
  if (step === 'nearby') {
    return (
      <OwnerScreen>
        <Text style={styles.step}>STEP 2 OF 3</Text>
        <Text accessibilityRole="header" style={screenText.title}>Is your venue already listed?</Text>
        <Text style={screenText.body}>These approved listings are close to your pin or have a similar name. If one is yours, claim it instead of adding a new venue.</Text>
        <DuplicateList duplicates={duplicates} onClaim={(id) => router.push({ pathname: '/owner/claim/[id]', params: { id } })} />
        <Button label="My venue isn’t listed here" variant="accent" onPress={() => { setAcknowledged(true); setMessage(null); setStep('details'); }} />
        <Button label="Move the pin" variant="secondary" onPress={() => setStep('locate')} />
      </OwnerScreen>
    );
  }
  if (step === 'details') {
    return (
      <OwnerScreen>
        <Text style={styles.step}>STEP 3 OF 3</Text>
        <Text accessibilityRole="header" style={screenText.title}>About the venue</Text>
        <Text style={screenText.body}>You can change these, name your courts and add more after this step. Players see the venue once pickly approves it.</Text>
        <Field label="Venue name" value={draft.name} onChangeText={field('name')} maxLength={120} editable={busy === null} autoCapitalize="words" />
        <Field label="Street address" value={draft.address_line} onChangeText={field('address_line')} maxLength={240} editable={busy === null} />
        <Field label="City or municipality" value={draft.city} onChangeText={field('city')} maxLength={80} editable={busy === null} />
        <Field label="Province" value={draft.province} onChangeText={field('province')} maxLength={80} editable={busy === null} hint="For example, Metro Manila or Cebu." />
        <Field label="Number of pickleball courts" value={draft.courts} onChangeText={field('courts')} keyboardType="number-pad" maxLength={2} editable={busy === null} />
        <EvidencePicker value={evidence} onChange={setEvidence} disabled={busy !== null} />
        <Field label="Anything reviewers should know (optional)" value={draft.note} onChangeText={field('note')} multiline maxLength={500}
          style={styles.note} editable={busy === null} />
        {alert}
        <Button label="Add your venue" loading={busy === 'submit'} onPress={() => void submit()} />
        <Button label="Back to the pin" variant="secondary" disabled={busy !== null} onPress={() => setStep('locate')} />
      </OwnerScreen>
    );
  }
  return (
    <OwnerScreen>
      <Text style={styles.step}>STEP 1 OF 3</Text>
      <Text accessibilityRole="header" style={screenText.title}>Where are the courts?</Text>
      <Text style={screenText.body}>Search the address, use your location at the venue, or tap the map. Then drag the pin onto the courts.</Text>
      <Field label="Address search" value={query} onChangeText={setQuery} maxLength={200} returnKeyType="search"
        onSubmitEditing={() => void search()} editable={busy === null} />
      <View style={styles.actions}>
        <Button label="Search address" style={styles.action} loading={busy === 'search'} disabled={busy !== null && busy !== 'search'} onPress={() => void search()} />
        <Button label="Use my location" variant="secondary" style={styles.action} loading={busy === 'locate'} disabled={busy !== null && busy !== 'locate'} onPress={() => void locateHere()} />
      </View>
      {candidates && (
        <View style={styles.list}>
          {candidates.length === 0
            ? <Text accessibilityLiveRegion="polite" style={screenText.body}>No matching Philippine addresses. Try a nearby street or landmark, or tap the map.</Text>
            : candidates.map((candidate) => (
              <Pressable key={`${candidate.latitude},${candidate.longitude},${candidate.label}`} accessibilityRole="button"
                accessibilityHint="Moves the pin to this address." onPress={() => choose(candidate)}
                style={({ pressed }) => [styles.candidate, pressed && styles.pressed]}>
                <Text style={styles.candidateText}>{candidate.label}</Text>
              </Pressable>
            ))}
          <Text style={styles.small}>Address results from Google</Text>
        </View>
      )}
      <PinMap pin={pin} focus={focus} onPinChange={(next) => movePin(next, false)} />
      <Text accessibilityLiveRegion="polite" style={screenText.body}>
        {pin ? `Pin placed at ${pin.latitude.toFixed(5)}, ${pin.longitude.toFixed(5)}.` : 'No pin placed yet.'}
      </Text>
      {alert}
      <Button label="Continue" variant="accent" loading={busy === 'nearby'} disabled={!pin || (busy !== null && busy !== 'nearby')} onPress={() => void checkNearby()} />
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  step: { fontFamily: fonts.semibold, color: colors.brandGreen, fontSize: 11, lineHeight: 17, letterSpacing: 1.5 },
  error: { color: colors.error, fontFamily: fonts.medium, fontSize: 15, lineHeight: 22 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flexGrow: 1, flexBasis: 150 },
  list: { gap: 8 },
  candidate: { borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14, backgroundColor: colors.surface },
  candidateText: { fontFamily: fonts.medium, color: colors.text, fontSize: 15, lineHeight: 22 },
  pressed: { backgroundColor: colors.selectedBackground },
  small: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  note: { minHeight: 96, textAlignVertical: 'top' },
});
