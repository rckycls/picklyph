import type { OwnerSubmission, RegistrationPreview } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EvidencePicker } from '@/features/owner/EvidencePicker';
import { liveCheckClaimCode, liveSubmit } from '@/features/owner/liveOwner';
import { ownerFailureMessage, type EvidenceFile } from '@/features/owner/ownerClient';
import { claimCodeInput, registrationRequest } from '@/features/owner/ownerForm';
import { OwnerGate } from '@/features/owner/OwnerGate';
import { useOwnerMode } from '@/features/owner/OwnerMode';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

type Step = { kind: 'code' } | { kind: 'confirm'; code: string; venue: RegistrationPreview } | { kind: 'done'; submission: OwnerSubmission };

export default function ClaimCodeRoute() {
  return <OwnerGate><ClaimCodeScreen /></OwnerGate>;
}

/** T54: an owner who registered before launch enters the emailed code, confirms the venue and adds proof. */
function ClaimCodeScreen() {
  const owner = useOwnerMode();
  const [step, setStep] = useState<Step>({ kind: 'code' });
  const [typed, setTyped] = useState('');
  const [evidence, setEvidence] = useState<EvidenceFile | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // One request ID per confirmed code: a retry after a dropped reply returns the original submission.
  const requestId = useRef(randomUUID());

  const check = async () => {
    const input = claimCodeInput(typed);
    if (!input.ok) { setMessage(input.message); return; }
    setBusy(true); setMessage(null);
    const outcome = await liveCheckClaimCode(input.code);
    setBusy(false);
    if (!outcome.ok) { setMessage(ownerFailureMessage(outcome.failure)); return; }
    requestId.current = randomUUID();
    setStep({ kind: 'confirm', code: input.code, venue: outcome.value });
  };

  const claim = async (code: string) => {
    if (!evidence) { setMessage('Add a photo that shows you own or manage this venue.'); return; }
    const built = registrationRequest(code, note, requestId.current);
    if (!built.ok) { setMessage(built.message); return; }
    setBusy(true); setMessage(null);
    const outcome = await liveSubmit(built.request, evidence);
    setBusy(false);
    if (outcome.ok && outcome.value.status !== 'duplicates') {
      setStep({ kind: 'done', submission: outcome.value.submission });
      owner.refresh();
      return;
    }
    setMessage(outcome.ok ? 'This code couldn’t be claimed. Try again.' : ownerFailureMessage(outcome.failure));
  };

  const alert = message && <Text accessibilityRole="alert" style={styles.error}>{message}</Text>;

  if (step.kind === 'done') {
    const draftId = step.submission.venue_id;
    return (
      <OwnerScreen>
        <Card tone="highlight">
          <StatusBadge label="Venue under review" tone="pending" />
          <Text accessibilityRole="header" style={screenText.title}>Your venue is claimed.</Text>
          <Text accessibilityLiveRegion="polite" style={screenText.body}>
            Set up your courts, hours, photos and policies now. A pickly reviewer checks your proof photo, then publishes the venue on Discover.
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

  if (step.kind === 'confirm') {
    const { venue } = step;
    return (
      <OwnerScreen>
        <Card>
          <StatusBadge label="Registered before launch" tone="pending" />
          <Text accessibilityRole="header" style={screenText.title}>{venue.name}</Text>
          <Text style={screenText.body}>{venue.address_line}, {venue.city}, {venue.province}</Text>
          <Text style={screenText.body}>{venue.court_count === 1 ? '1 court' : `${venue.court_count} courts`}</Text>
        </Card>
        <Card>
          <Text style={screenText.body}>
            If this is the venue you registered, add a photo that shows you own or manage it. Reviewers see your proof and account email; players never do.
          </Text>
          <EvidencePicker value={evidence} onChange={setEvidence} disabled={busy} />
          <Field label="Anything reviewers should know (optional)" value={note} onChangeText={setNote} multiline maxLength={500}
            style={styles.note} editable={!busy} />
          {alert}
          <Button label="Claim this venue" loading={busy} onPress={() => void claim(step.code)} />
          <Button label="Use a different code" variant="secondary" disabled={busy}
            onPress={() => { setStep({ kind: 'code' }); setMessage(null); }} />
        </Card>
      </OwnerScreen>
    );
  }

  return (
    <OwnerScreen>
      <Text accessibilityRole="header" style={screenText.title}>Claim with your code</Text>
      <Text style={screenText.body}>
        Registered your courts on the pickly website before launch? Enter the claim code from your email. Each code works once.
      </Text>
      <Field label="Claim code" value={typed} onChangeText={setTyped} maxLength={20} autoCapitalize="characters" autoCorrect={false}
        autoComplete="off" spellCheck={false} returnKeyType="go" onSubmitEditing={() => void check()} editable={!busy}
        hint="10 letters and numbers, like ABCDE-FGHJK." style={styles.code} />
      {alert}
      <Button label="Check code" loading={busy} onPress={() => void check()} />
      <Text style={styles.small}>No code? Add your venue from Account instead, or claim a listing you find on Discover.</Text>
    </OwnerScreen>
  );
}

const styles = StyleSheet.create({
  error: { color: colors.error, fontFamily: fonts.medium, fontSize: 15, lineHeight: 22 },
  note: { minHeight: 96, textAlignVertical: 'top' },
  code: { fontFamily: fonts.semibold, letterSpacing: 2 },
  small: { fontFamily: fonts.medium, color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
});
