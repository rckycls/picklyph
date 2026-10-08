import { formatPhpCentavos, type OpenPlaySession, type SessionBooking, type SessionWalkIn } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { screenText } from '@/components/ui/Screen';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';
import type { OwnerHttpTransport } from './venueClient';
import { listWalkIns, walkInDraft, walkInFailureMessage, walkInNames } from './walkInClient';

/** Walk-ins share the session's spot count with player groups; the server re-checks every limit under the session lock. */
export function SessionWalkIns({ session, transport, refreshKey, disabled, onAdd, onRemove }: {
  session: OpenPlaySession; transport: OwnerHttpTransport; refreshKey: string; disabled: boolean;
  onAdd: (command: SessionWalkIn) => Promise<boolean>; onRemove: (bookingId: string) => Promise<void>;
}) {
  const snap = session.snapshot; const open = snap.capacity - session.reserved_spots;
  const [names, setNames] = useState(''); const [walkIns, setWalkIns] = useState<SessionBooking[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); const [message, setMessage] = useState<string | null>(null); const [confirm, setConfirm] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback((after: string | null) => {
    request.current?.abort(); const abort = new AbortController(); request.current = abort; setLoading(true);
    void listWalkIns(transport, session.id, after, abort.signal).then(outcome => {
      if (abort.signal.aborted) return;
      setLoading(false);
      if (!outcome.ok) { setMessage(walkInFailureMessage(outcome.failure)); return; }
      setMessage(null); setCursor(outcome.value.next_cursor);
      setWalkIns(previous => after ? [...previous, ...outcome.value.bookings].filter((b, i, all) => all.findIndex(x => x.id === b.id) === i) : outcome.value.bookings);
    }, () => { if (!abort.signal.aborted) { setLoading(false); setMessage('Couldn’t load the walk-ins. Reload the sessions to try again.'); } });
  }, [transport, session.id]);
  // The parent's refresh key changes after every reload, so counts and the list stay in step.
  useFocusEffect(useCallback(() => { void refreshKey; load(null); return () => request.current?.abort(); }, [load, refreshKey]));
  const count = walkInNames(names).length;
  const preview = useMemo(() => {
    if (!count) return { ok: false, text: 'Enter one name per line.' };
    if (count > snap.group_limit) return { ok: false, text: `Up to ${snap.group_limit} people per walk-in group. Add the rest as another group.` };
    if (count > open) return { ok: false, text: open ? `Only ${open} spots left.` : 'This session is full.' };
    try {
      const draft = walkInDraft({ sessionId: session.id, requestId: session.id, names, priceCentavos: snap.price_centavos });
      return { ok: true, text: `${count} ${count === 1 ? 'person' : 'people'} · ${formatPhpCentavos(draft.expected_total_centavos)} due on arrival` };
    } catch { return { ok: false, text: 'Use 1–60 characters per name, with no repeated names.' }; }
  }, [count, names, open, session.id, snap.group_limit, snap.price_centavos]);
  const add = async () => {
    let command: SessionWalkIn;
    try { command = walkInDraft({ sessionId: session.id, requestId: randomUUID(), names, priceCentavos: snap.price_centavos }); }
    catch { setMessage('Use 1–60 characters per name, with no repeated names.'); return; }
    if (await onAdd(command)) setNames('');
  };
  const live = walkIns.filter(b => b.status === 'confirmed');
  return <View style={styles.panel}>
    <Text accessibilityRole="header" style={screenText.label}>Walk-ins</Text>
    <Text style={screenText.body}>{open} of {snap.capacity} spots open · up to {snap.group_limit} per group · {formatPhpCentavos(snap.price_centavos)} per person, paid at the venue.</Text>
    <View style={styles.field}>
      <Text style={screenText.label}>Names, one per line</Text>
      <TextInput accessibilityLabel="Walk-in names, one per line" value={names} onChangeText={setNames} editable={!disabled} multiline
        autoCapitalize="words" autoCorrect={false} maxLength={4000} style={styles.input} />
    </View>
    <Text accessibilityLiveRegion="polite" style={screenText.body}>{preview.text}</Text>
    <Button label="Add walk-ins" disabled={disabled || !preview.ok} onPress={() => void add()} />
    {loading && <ActivityIndicator accessibilityLabel="Loading walk-ins" color={colors.primary} />}
    {message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
    {!loading && !live.length && <Text style={screenText.body}>No walk-ins yet.</Text>}
    {live.map(b => <View key={b.id} style={styles.entry}>
      <Text style={screenText.body}>{b.participants.join(', ')}</Text>
      <Text style={screenText.body}>{b.spots} {b.spots === 1 ? 'person' : 'people'} · {formatPhpCentavos(b.snapshot.total_centavos)} · Unpaid</Text>
      {confirm === b.id ? <>
        <Text style={screenText.body}>Remove this walk-in group? Their spots open again.</Text>
        <Button label="Confirm removal" disabled={disabled} onPress={() => void onRemove(b.id).finally(() => setConfirm(null))} />
        <Button label="Keep walk-in" variant="secondary" onPress={() => setConfirm(null)} />
      </> : <Button label="Remove walk-in" variant="secondary" disabled={disabled} onPress={() => setConfirm(b.id)} />}
    </View>)}
    {cursor && <Button label="Load more walk-ins" variant="secondary" disabled={loading} onPress={() => load(cursor)} />}
  </View>;
}
const styles = StyleSheet.create({
  panel: { gap: 10, paddingTop: 12, borderTopWidth: 1, borderColor: colors.border },
  field: { gap: 6 }, entry: { gap: 6, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  input: { minHeight: 96, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12, textAlignVertical: 'top',
    color: colors.text, backgroundColor: colors.surface, fontFamily: fonts.medium, fontSize: 16 },
});
