import { formatManilaDateTime, formatPhpCentavos, type RentalBooking } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { PicklyMascot } from '@/components/mascot/PicklyMascot';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { loadHistory, type RentalFailure } from './client';
import { bookingStatus, createGeneration, mergeHistory } from './model';
import { Recovery, useAttempt } from './Recovery';
import { RentalError } from './ui';
import { useRetryWait } from './useRetryWait';

/** Body of the Bookings tab's rental view. */
export function RentalHistory({ actor }: { actor: string }) {
  const recovery = useAttempt(actor);
  const [rows, setRows] = useState<RentalBooking[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false); const [busy, setBusy] = useState(false); const [failure, setFailure] = useState<RentalFailure | null>(null);
  const wait = useRetryWait(failure);
  const [revision, setRevision] = useState(0); const generation = useRef(createGeneration()).current;
  const lock = useRef(false); const abort = useRef<AbortController | null>(null);
  const page = useCallback(async (after: string | null) => {
    if (lock.current) return;
    lock.current = true; const version = generation.next(); const controller = new AbortController(); abort.current = controller;
    setBusy(true); setFailure(null);
    try {
      const result = await loadHistory(recovery.transport, after, controller.signal);
      if (controller.signal.aborted || !generation.current(version)) return;
      if (result.ok) { setRows((old) => mergeHistory(old, result.value, after)); setCursor(result.value.next_cursor); setLoaded(true); }
      else setFailure(result.failure);
    } catch { if (!controller.signal.aborted && generation.current(version)) setFailure({ kind: 'unavailable', retryAfterSeconds: null }); }
    finally { if (generation.current(version)) { lock.current = false; setBusy(false); } }
  }, [recovery.transport, generation]);
  const refresh = useCallback(() => { abort.current?.abort(); generation.next(); lock.current = false; setRevision((v) => v + 1); }, [generation]);
  useFocusEffect(useCallback(() => {
    void revision; // Refresh restarts at page one, including after foreground return.
    void page(null);
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => { abort.current?.abort(); generation.next(); lock.current = false; listener.remove(); };
  }, [page, revision, generation, refresh]));
  return <>
    <Recovery recovery={recovery} />
    <Button label={wait ? `Refresh in ${wait}s` : busy ? 'Checking bookings…' : 'Refresh bookings'} variant="secondary" loading={busy} disabled={wait > 0} onPress={refresh} />
    {failure && <RentalError failure={failure} />}
    {failure && rows.length > 0 && <Text style={screenText.body}>The list below shows the last received records. Refresh to check current statuses.</Text>}
    {loaded && rows.length === 0 && !busy && !failure && <Card><View style={{ alignItems: 'center' }}><PicklyMascot size={160} /></View><Text style={screenText.title}>Find your next game.</Text>
      <Text style={screenText.body}>Your reservations and requests will appear here. Choose a verified venue in Discover to review a rental.</Text></Card>}
    {rows.map((b) => { const status = bookingStatus(b); return <Card key={b.id}>
      <StatusBadge label={status.label} tone={status.tone} />
      <Text style={screenText.title}>{formatManilaDateTime(b.snapshot.starts_at)}</Text>
      <Text style={screenText.body}>{b.snapshot.duration_minutes} min · {formatPhpCentavos(b.snapshot.total_centavos)} · arrival payment
        {'\n'}Court {b.allocation.court_id.slice(0, 8)} · reference {b.id.slice(0, 8)}</Text>
      <Button label="View booking" accessibilityLabel={`View ${status.label.toLowerCase()} rental on ${formatManilaDateTime(b.snapshot.starts_at)}`}
        onPress={() => router.push({ pathname: '/rental/booking/[id]', params: { id: b.id } })} />
    </Card>; })}
    {cursor && <Button label={rows.length >= 200 ? 'Refresh to check new bookings' : 'Load more bookings'} variant="secondary" disabled={busy || wait > 0}
      onPress={() => { if (rows.length >= 200) refresh(); else void page(cursor); }} />}
    {rows.length > 0 && <Text style={screenText.body}>Showing {rows.length} loaded bookings, newest first. Refresh starts from page one to find new reservations.</Text>}
  </>;
}
