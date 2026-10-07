import type { OwnerVenue } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { liveOwnedVenue, liveSaveVenue } from './liveOwner';
import { OwnerScreen } from './OwnerScreen';
import { venueFailureMessage, type VenueFailure } from './venueClient';
import {
  SURFACE_LABELS, addCourt, draftFrom, isDirty, removeNewCourt, saveCommand, updateCourt,
  type CourtDraft, type VenueDraft,
} from './venueDraft';
import { VenuePhotos } from './VenuePhotos';

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'error'; failure: VenueFailure };

/** Details, courts and photos of one venue the signed-in owner manages. Pin and status are read-only. */
export function VenueEditor({ venueId }: { venueId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [venue, setVenue] = useState<OwnerVenue | null>(null);
  const [draft, setDraft] = useState<VenueDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; conflict: boolean } | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    liveOwnedVenue(venueId, signal).then((outcome) => {
      if (signal?.aborted) return;
      if (!outcome.ok) { setLoaded({ status: 'error', failure: outcome.failure }); return; }
      setVenue(outcome.value); setDraft(draftFrom(outcome.value)); setMessage(null); setLoaded({ status: 'ready' });
    }, () => { if (!signal?.aborted) setLoaded({ status: 'error', failure: { kind: 'network', retryAfterSeconds: null } }); });
  }, [venueId]);
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal);
    return () => abort.abort();
  }, [load]);

  if (loaded.status === 'loading' || (loaded.status === 'ready' && (!venue || !draft))) {
    return (
      <OwnerScreen>
        <View accessibilityLiveRegion="polite" style={styles.row}>
          <ActivityIndicator color={colors.primary} accessible={false} />
          <Text style={screenText.body}>Loading your venue…</Text>
        </View>
      </OwnerScreen>
    );
  }
  if (loaded.status === 'error' || !venue || !draft) {
    const failure = loaded.status === 'error' ? loaded.failure : null;
    return (
      <OwnerScreen>
        <Card>
          <Text accessibilityRole="alert" style={screenText.body}>
            {failure ? venueFailureMessage(failure) : 'Couldn’t load this venue.'}
          </Text>
          <Button label="Try again" variant="secondary" onPress={() => { setLoaded({ status: 'loading' }); load(); }} />
        </Card>
      </OwnerScreen>
    );
  }

  const dirty = isDirty(draft, venue);
  const edit = (patch: Partial<VenueDraft>) => { setDraft({ ...draft, ...patch }); setMessage(null); };
  const editCourt = (key: string, patch: Partial<Omit<CourtDraft, 'key' | 'id'>>) => { setDraft(updateCourt(draft, key, patch)); setMessage(null); };
  const save = async () => {
    const built = saveCommand(draft, venue);
    if (!built.ok) { setMessage({ text: built.message, conflict: false }); return; }
    setSaving(true); setMessage(null);
    const outcome = await liveSaveVenue(built.command);
    setSaving(false);
    if (outcome.ok) {
      setVenue(outcome.value); setDraft(draftFrom(outcome.value));
      setMessage({ text: 'Saved. Players see the updated listing now.', conflict: false });
      return;
    }
    const conflict = outcome.failure.kind === 'rejected' && outcome.failure.reason === 'version_conflict';
    setMessage({ text: venueFailureMessage(outcome.failure), conflict });
  };

  return (
    <OwnerScreen>
      <Card>
        <View style={styles.chips}>
          <StatusBadge label="Published" tone="success" />
          <StatusBadge label="You manage this venue" tone="neutral" />
        </View>
        <Text accessibilityRole="header" style={screenText.title}>{venue.name}</Text>
        <Text style={screenText.body}>
          Changes save to your public listing. The map pin and listing status are managed by pickly; contact pickly support to move the pin.
        </Text>
      </Card>

      <Card>
        <Text accessibilityRole="header" style={screenText.title}>Venue details</Text>
        <Field label="Venue name" value={draft.name} onChangeText={(name) => edit({ name })} maxLength={120} editable={!saving} />
        <Field label="Street address" value={draft.address_line} onChangeText={(address_line) => edit({ address_line })} maxLength={240} editable={!saving} />
        <Field label="City or municipality" value={draft.city} onChangeText={(city) => edit({ city })} maxLength={80} editable={!saving} />
        <Field label="Province" value={draft.province} onChangeText={(province) => edit({ province })} maxLength={80} editable={!saving} />
      </Card>

      <Card>
        <Text accessibilityRole="header" style={screenText.title}>Courts</Text>
        <Text style={screenText.body}>Inactive courts stay on file but aren’t shown to players. Keep at least one court active.</Text>
        {draft.courts.map((court, index) => (
          <CourtFields key={court.key} court={court} position={index + 1} disabled={saving}
            onChange={(patch) => editCourt(court.key, patch)}
            onRemove={court.id === null ? () => { setDraft(removeNewCourt(draft, court.key)); setMessage(null); } : null} />
        ))}
        <Button label="Add a court" variant="secondary" disabled={saving || draft.courts.length >= 40}
          onPress={() => { setDraft(addCourt(draft, randomUUID())); setMessage(null); }} />
      </Card>

      <Card>
        {message && (
          <Text accessibilityRole={message.conflict ? 'alert' : undefined} accessibilityLiveRegion="polite"
            style={[screenText.body, message.conflict && styles.error]}>{message.text}</Text>
        )}
        {message?.conflict && <Button label="Reload latest" variant="secondary" onPress={() => { setLoaded({ status: 'loading' }); load(); }} />}
        <Button label={dirty ? 'Save changes' : 'No unsaved changes'} loading={saving} disabled={!dirty || saving} onPress={() => void save()} />
        {dirty && <Button label="Discard changes" variant="secondary" disabled={saving} onPress={() => { setDraft(draftFrom(venue)); setMessage(null); }} />}
      </Card>

      <Card>
        <VenuePhotos venueId={venue.id} photos={venue.photos} disabled={saving}
          onChange={(photos) => setVenue((current) => (current ? { ...current, photos } : current))} />
      </Card>
    </OwnerScreen>
  );
}

function CourtFields({ court, position, onChange, onRemove, disabled }: {
  court: CourtDraft; position: number; disabled: boolean;
  onChange: (patch: Partial<Omit<CourtDraft, 'key' | 'id'>>) => void; onRemove: (() => void) | null;
}) {
  const label = court.name.trim() || `Court ${position}`;
  return (
    <View style={styles.court}>
      <View style={styles.chips}>
        {court.id === null && <StatusBadge label="New" tone="pending" />}
        {court.status === 'inactive' && <StatusBadge label="Inactive" tone="error" />}
      </View>
      <Field label={`Court ${position} name`} value={court.name} onChangeText={(name) => onChange({ name })} maxLength={80} editable={!disabled} />
      <Text style={screenText.label} nativeID={`surface-${court.key}`}>Surface</Text>
      <View style={styles.surfaces} accessibilityRole="radiogroup" accessibilityLabelledBy={`surface-${court.key}`}>
        {SURFACE_LABELS.map((option) => {
          const selected = court.surface === option.value;
          return (
            <Pressable key={option.label} accessibilityRole="radio" accessibilityState={{ checked: selected, disabled }}
              accessibilityLabel={`${label} surface: ${option.label}`} disabled={disabled} onPress={() => onChange({ surface: option.value })}
              style={({ pressed }) => [styles.surface, selected && styles.surfaceSelected, pressed && styles.pressed]}>
              <Text style={[styles.surfaceText, selected && styles.surfaceTextSelected]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Toggle label="Indoor" value={court.is_indoor} disabled={disabled} accessibilityLabel={`${label} is indoor`} onChange={(is_indoor) => onChange({ is_indoor })} />
      <Toggle label="Covered" value={court.is_covered} disabled={disabled} accessibilityLabel={`${label} is covered`} onChange={(is_covered) => onChange({ is_covered })} />
      <Toggle label="Active (shown to players)" value={court.status === 'active'} disabled={disabled} accessibilityLabel={`${label} is active`}
        onChange={(active) => onChange({ status: active ? 'active' : 'inactive' })} />
      {onRemove && <Button label="Remove new court" variant="secondary" disabled={disabled} accessibilityLabel={`Remove ${label}`} onPress={onRemove} />}
    </View>
  );
}

function Toggle({ label, value, onChange, disabled, accessibilityLabel }: {
  label: string; value: boolean; onChange: (value: boolean) => void; disabled: boolean; accessibilityLabel: string;
}) {
  return (
    <View style={styles.toggle}>
      <Text style={[screenText.body, styles.grow]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} disabled={disabled} accessibilityLabel={accessibilityLabel}
        trackColor={{ true: colors.secondary, false: colors.border }} ios_backgroundColor={colors.border} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  error: { color: colors.error },
  court: { gap: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14 },
  surfaces: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  surface: { minHeight: 44, paddingHorizontal: 14, borderRadius: 12, borderWidth: 2, borderColor: colors.border, justifyContent: 'center', backgroundColor: colors.surface },
  surfaceSelected: { borderColor: colors.primary, backgroundColor: colors.selectedBackground },
  surfaceText: { fontFamily: fonts.semibold, color: colors.textSecondary, fontSize: 14 },
  surfaceTextSelected: { color: colors.selectedText },
  pressed: { opacity: 0.7 },
  toggle: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 12 },
  grow: { flex: 1 },
});
