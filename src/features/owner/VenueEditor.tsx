import type { OwnerVenue } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';

import { liveOwnedVenue, liveSaveVenue } from './liveOwner';
import { OwnerScreen } from './OwnerScreen';
import { SaveFooter } from './SaveFooter';
import { venueFailureMessage, type VenueFailure } from './venueClient';
import {
  SURFACE_LABELS, addCourt, draftFrom, removeNewCourt, resetSection, saveCommand, sectionDirty, sectionDraft, updateCourt,
  type CourtDraft, type VenueDraft, type VenueSection,
} from './venueDraft';
import { VenuePhotos } from './VenuePhotos';
import { VenuePolicyForm } from './VenuePolicyForm';

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'error'; failure: VenueFailure };
type Tab = VenueSection | 'photos' | 'policies';
type Message = { section: VenueSection; text: string; conflict: boolean };

/**
 * Details, courts, photos and policies of one venue the signed-in owner manages, one tab each.
 * Every tab saves on its own; hidden tabs stay mounted so their unsaved edits survive switching.
 * Pin and status are read-only.
 */
export function VenueEditor({ venueId }: { venueId: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [venue, setVenue] = useState<OwnerVenue | null>(null);
  const [draft, setDraft] = useState<VenueDraft | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [saving, setSaving] = useState<VenueSection | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

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

  const detailsDirty = sectionDirty(draft, venue, 'details');
  const courtsDirty = sectionDirty(draft, venue, 'courts');
  const busy = saving !== null;
  // The owner's own new venue, editable while pickly reviews their proof.
  const underReview = venue.publication_status === 'draft';
  const edit = (patch: Partial<VenueDraft>) => { setDraft({ ...draft, ...patch }); setMessage(null); };
  const editCourt = (key: string, patch: Partial<Omit<CourtDraft, 'key' | 'id'>>) => { setDraft(updateCourt(draft, key, patch)); setMessage(null); };
  const reload = () => { setLoaded({ status: 'loading' }); load(); };
  const save = async (section: VenueSection) => {
    const built = saveCommand(sectionDraft(draft, venue, section), venue);
    if (!built.ok) { setMessage({ section, text: built.message, conflict: false }); return; }
    setSaving(section); setMessage(null);
    const outcome = await liveSaveVenue(built.command);
    setSaving(null);
    if (outcome.ok) {
      setVenue(outcome.value); setDraft((current) => (current ? resetSection(current, outcome.value, section) : current));
      setMessage({ section, conflict: false,
        text: underReview ? 'Saved. Players see it once pickly approves your venue.' : 'Saved. Players see the updated listing now.' });
      return;
    }
    const conflict = outcome.failure.kind === 'rejected' && outcome.failure.reason === 'version_conflict';
    setMessage({ section, text: venueFailureMessage(outcome.failure), conflict });
  };
  const footer = (section: VenueSection, dirty: boolean, label: string) => (
    <SaveFooter dirty={dirty} label={label} saving={saving === section} disabled={busy}
      message={message?.section === section ? message : null} onReload={reload}
      onSave={() => void save(section)} onDiscard={() => { setDraft(resetSection(draft, venue, section)); setMessage(null); }} />
  );
  // A dot marks a tab with unsaved edits, since its Save is out of sight.
  const tabs = [
    { value: 'details', label: detailsDirty ? 'Details •' : 'Details', accessibilityLabel: detailsDirty ? 'Details, unsaved changes' : 'Details' },
    { value: 'courts', label: courtsDirty ? 'Courts •' : 'Courts', accessibilityLabel: courtsDirty ? 'Courts, unsaved changes' : 'Courts' },
    { value: 'photos', label: 'Photos' },
    { value: 'policies', label: 'Policies' },
  ] as const;

  return (
    <OwnerScreen>
      <Card>
        <View style={styles.chips}>
          {underReview ? <>
            <StatusBadge label="Under review" tone="pending" />
            <StatusBadge label="Not on Discover yet" tone="neutral" />
          </> : <>
            <StatusBadge label="Published" tone="success" />
            <StatusBadge label="You manage this venue" tone="neutral" />
          </>}
        </View>
        <Text accessibilityRole="header" style={screenText.title}>{venue.name}</Text>
        <Text style={screenText.body}>
          {underReview
            ? 'Set up your courts, photos, hours and policies now. pickly checks your proof photo, then publishes the venue so players can find and book it. The map pin is managed by pickly; contact pickly support to move it.'
            : 'Changes save to your public listing. The map pin and listing status are managed by pickly; contact pickly support to move the pin.'}
        </Text>
      </Card>

      <SegmentedControl options={tabs} value={tab} onChange={setTab} accessibilityLabel="Venue sections" />

      <Card style={tab !== 'details' && styles.hidden}>
        <Text accessibilityRole="header" style={screenText.title}>Venue details</Text>
        <Field label="Venue name" value={draft.name} onChangeText={(name) => edit({ name })} maxLength={120} editable={!busy} />
        <Field label="Street address" value={draft.address_line} onChangeText={(address_line) => edit({ address_line })} maxLength={240} editable={!busy} />
        <Field label="City or municipality" value={draft.city} onChangeText={(city) => edit({ city })} maxLength={80} editable={!busy} />
        <Field label="Province" value={draft.province} onChangeText={(province) => edit({ province })} maxLength={80} editable={!busy} />
        {footer('details', detailsDirty, 'Save details')}
      </Card>

      <Card style={tab !== 'courts' && styles.hidden}>
        <Text accessibilityRole="header" style={screenText.title}>Courts</Text>
        <Text style={screenText.body}>Inactive courts stay on file but aren’t shown to players. Keep at least one court active.</Text>
        {draft.courts.map((court, index) => (
          <CourtFields key={court.key} court={court} position={index + 1} disabled={busy}
            onChange={(patch) => editCourt(court.key, patch)}
            onRemove={court.id === null ? () => { setDraft(removeNewCourt(draft, court.key)); setMessage(null); } : null} />
        ))}
        <Button label="Add a court" variant="secondary" disabled={busy || draft.courts.length >= 40}
          onPress={() => { setDraft(addCourt(draft, randomUUID())); setMessage(null); }} />
        {footer('courts', courtsDirty, 'Save courts')}
      </Card>

      <Card style={tab !== 'photos' && styles.hidden}>
        <VenuePhotos venueId={venue.id} photos={venue.photos} disabled={busy}
          onChange={(photos) => setVenue((current) => (current ? { ...current, photos } : current))} />
      </Card>
      <Card style={tab !== 'policies' && styles.hidden}><VenuePolicyForm venueId={venue.id} /></Card>
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
  hidden: { display: 'none' },
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
