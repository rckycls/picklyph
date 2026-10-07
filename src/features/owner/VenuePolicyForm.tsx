import type { VenuePolicy, VenuePolicyView } from '@picklyph/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { screenText } from '@/components/ui/Screen';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { liveSavePolicy, liveVenuePolicy } from './liveOwner';
import { venueFailureMessage } from './venueClient';

export function VenuePolicyForm({ venueId }: { venueId: string }) {
  const [saved, setSaved] = useState<VenuePolicyView | null>(null);
  const [draft, setDraft] = useState<VenuePolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setSaved(null); setDraft(null); setBusy(true); setMessage(null); setConflict(false);
    void liveVenuePolicy(venueId, abort.signal).then((outcome) => {
      if (abort.signal.aborted) return;
      setBusy(false);
      if (outcome.ok) { setSaved(outcome.value); setDraft({ confirmation: outcome.value.confirmation, payment: outcome.value.payment }); }
      else setMessage(venueFailureMessage(outcome.failure));
    }, () => { if (!abort.signal.aborted) { setBusy(false); setMessage('Couldn’t load these policies. Try again.'); } });
  }, [venueId]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) load(); });
    return () => { active = false; request.current?.abort(); };
  }, [load]);
  const save = async () => {
    if (!saved || !draft || busy) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setBusy(true); setMessage(null); setConflict(false);
    try {
      const outcome = await liveSavePolicy({ kind: 'save_policy', venue_id: venueId, expected_revision: saved.revision, policy: draft }, abort.signal);
      if (abort.signal.aborted) return;
      if (outcome.ok) { setSaved(outcome.value); setDraft({ confirmation: outcome.value.confirmation, payment: outcome.value.payment }); setMessage('Venue policies saved.'); }
      else { setMessage(venueFailureMessage(outcome.failure)); setConflict(outcome.failure.kind === 'rejected' && outcome.failure.reason === 'version_conflict'); }
    } catch { if (!abort.signal.aborted) setMessage('Couldn’t confirm the save. Reload to check the latest policies.'); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const dirty = saved && draft && (saved.confirmation !== draft.confirmation || saved.payment !== draft.payment);
  return <View style={styles.form}>
    <Text accessibilityRole="header" style={screenText.title}>Booking policies</Text>
    <Text style={screenText.body}>Choose how future reservations are confirmed and paid at this venue.</Text>
    {busy && !saved && <ActivityIndicator color={colors.primary} accessibilityLabel="Loading venue policies" />}
    {saved && draft && <>
      <Text style={screenText.label}>Confirmation</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Booking confirmation" style={styles.options}>
        <Choice label="Instant confirmation" selected={draft.confirmation === 'instant'} disabled={busy} onPress={() => setDraft({ ...draft, confirmation: 'instant' })} />
        <Choice label="Owner approval" selected={draft.confirmation === 'approval'} disabled={busy} onPress={() => setDraft({ ...draft, confirmation: 'approval' })} />
      </View>
      <Text style={screenText.label}>Payment options</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Allowed payment options" style={styles.options}>
        <Choice label="Pay on arrival" selected={draft.payment === 'arrival'} disabled={busy} onPress={() => setDraft({ ...draft, payment: 'arrival' })} />
        <Choice label="Online only" selected={draft.payment === 'online'} disabled={busy || !saved.merchant_active} onPress={() => setDraft({ ...draft, payment: 'online' })} />
        <Choice label="Online or arrival" selected={draft.payment === 'both'} disabled={busy || !saved.merchant_active} onPress={() => setDraft({ ...draft, payment: 'both' })} />
      </View>
      {!saved.merchant_active && <Text style={screenText.body}>Online payment is available after pickly verifies and activates this venue’s merchant account. Pay on arrival remains available.</Text>}
      <Button label="Save policies" disabled={!dirty || busy || conflict} loading={busy} onPress={() => void save()} />
      {dirty && <Button label="Discard policy changes" variant="secondary" disabled={busy} onPress={() => { setDraft({ confirmation: saved.confirmation, payment: saved.payment }); setMessage(null); setConflict(false); }} />}
    </>}
    {message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
    {(!saved && !busy || conflict) && <Button label="Reload policies" variant="secondary" onPress={load} />}
  </View>;
}

function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    style={[styles.choice, selected && styles.selected, disabled && styles.disabled]}>
    <Text style={[styles.label, selected && styles.selectedLabel]}>{label}</Text>
  </Pressable>;
}
const styles = StyleSheet.create({
  form: { gap: 12 }, options: { gap: 8 },
  choice: { minHeight: 44, padding: 12, borderWidth: 2, borderColor: colors.border, borderRadius: 12 },
  selected: { backgroundColor: colors.selectedBackground, borderColor: colors.primary }, disabled: { opacity: 0.5 },
  label: { fontFamily: fonts.semibold, fontSize: 15, color: colors.textSecondary }, selectedLabel: { color: colors.selectedText },
});
