import { formatPhpCentavos } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { rentalCelebrations } from '../rental/celebration';
import { useRentalRead } from '../rental/useRentalRead';
import { useRetryWait } from '../rental/useRetryWait';
import { loadOffer, requestGroup, type GroupFailure } from './client';
import { groupPreview, groupRequest, maxGroupRows, offerState, spotsLabel } from './model';
import { GroupRecovery, useGroupAttempt } from './Recovery';
import { GroupError, GroupReview, SessionTimes } from './ui';

export function GroupReserve({ actor, sessionId }: { actor: string; sessionId: string }) {
  const recovery = useGroupAttempt(actor); const { transport, journal } = recovery;
  const read = useCallback((signal: AbortSignal) => loadOffer(transport, sessionId, signal), [transport, sessionId]);
  const state = useRentalRead(read);
  const [venue, setVenue] = useState<VenueDetail | null>(null);
  const [rows, setRows] = useState<string[]>(['']); const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<GroupFailure | null>(null); const [message, setMessage] = useState<string | null>(null);
  const wait = useRetryWait(failure ?? state.failure); const lock = useRef(false); const focused = useRef(false);
  const venueId = state.value?.session.venue_id;
  useFocusEffect(useCallback(() => {
    focused.current = true; const abort = new AbortController();
    if (venueId) void loadLiveVenueDetail(venueId, abort.signal).then((v) => { if (!abort.signal.aborted) setVenue(v); }).catch(() => {});
    return () => { focused.current = false; abort.abort(); };
  }, [venueId]));
  const offer = state.value?.session ?? null; const at = state.value?.at ?? null;
  const preview = offer && at ? groupPreview(offer, at, rows) : null;
  const limit = offer ? maxGroupRows(offer) : 1;
  const edit = (index: number, value: string | null) => {
    setFailure(null); setMessage(null);
    setRows((old) => value === null ? old.filter((_, i) => i !== index) : old.map((row, i) => i === index ? value : row));
  };
  const reserve = async () => {
    if (!offer || !preview?.ok || lock.current) return;
    lock.current = true; setBusy(true); setFailure(null); setMessage(null);
    try {
      const result = await journal.run(groupRequest(offer, preview.names, randomUUID()), (command) => requestGroup(transport, command));
      if (!focused.current) return;
      recovery.refresh();
      if (result.ok) {
        rentalCelebrations.requested(actor, result.value.booking);
        router.push({ pathname: '/play/booking/[id]', params: { id: result.value.booking.id } });
      } else { setFailure(result.failure); state.refresh(); }
    } catch { if (focused.current) { setMessage('Couldn’t confirm the group request. Check original-request recovery before trying again.'); recovery.refresh(); } }
    finally { lock.current = false; if (focused.current) setBusy(false); }
  };
  const blocked = busy || wait > 0 || state.busy || !recovery.checked || Boolean(recovery.attempt || recovery.error);
  const open = offer && at ? offerState(offer, at) === 'open' : false;
  return <OwnerScreen><Text style={screenText.title}>{offer?.snapshot.title ?? 'Open play'}</Text>
    {venue && <Text style={screenText.label}>{venue.name} · {venue.city}</Text>}
    <GroupRecovery recovery={recovery} />
    <Button label={wait ? `Refresh in ${wait}s` : state.busy ? 'Checking current spots…' : 'Refresh spots'} variant="secondary" loading={state.busy} disabled={busy || wait > 0} onPress={state.refresh} />
    {state.failure && <GroupError failure={state.failure} />}
    {offer && at && <><Card>
      <StatusBadge label={spotsLabel(offer, at)} tone={open ? 'success' : 'neutral'} />
      <SessionTimes snapshot={offer.snapshot} venue={venue} />
      <Text style={screenText.body}>{formatPhpCentavos(offer.snapshot.price_centavos)} per person · up to {offer.snapshot.group_limit} per group
        {'\n'}{offer.snapshot.policy.confirmation === 'approval' ? 'Venue approval required' : 'Instant confirmation'} · pay at the venue</Text>
      {state.failure && <Text style={screenText.body}>These are the last received details. Refresh to check current spots.</Text>}
    </Card>
      {open && <Card><Text accessibilityRole="header" style={screenText.title}>Who’s playing?</Text>
        <Text style={screenText.body}>Enter one name per person, including yourself. The group books, pays and cancels together.</Text>
        {rows.map((row, i) => <View key={i} style={{ gap: 8 }}>
          <Field label={`Person ${i + 1}`} hint={i === 0 ? 'Usually you' : undefined} value={row} maxLength={60} autoCapitalize="words" autoCorrect={false}
            textContentType={i === 0 ? 'name' : 'none'} editable={!busy} onChangeText={(v) => edit(i, v)} />
          {rows.length > 1 && <Button label={`Remove person ${i + 1}`} variant="secondary" disabled={busy} onPress={() => edit(i, null)} />}
        </View>)}
        {rows.length < limit && <Button label="Add another person" variant="secondary" disabled={busy} onPress={() => setRows((old) => [...old, ''])} />}
        <Text accessibilityLiveRegion="polite" style={screenText.body}>{preview?.text}</Text>
      </Card>}
      {preview?.ok && <><GroupReview snapshot={offer.snapshot} names={preview.names} total={preview.total_centavos} />
        <Button label={offer.snapshot.policy.confirmation === 'approval' ? 'Request spots · pay at venue' : 'Reserve spots · pay at venue'} variant="accent"
          disabled={blocked} loading={busy} onPress={() => void reserve()} /></>}
      {!open && preview && <Text accessibilityLiveRegion="polite" style={screenText.body}>{preview.text}</Text>}
    </>}
    {failure && <GroupError failure={failure} />}{message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
    {offer && <Button label="Other sessions here" variant="secondary" onPress={() => router.push({ pathname: '/play/venue/[id]', params: { id: offer.venue_id } })} />}
  </OwnerScreen>;
}
