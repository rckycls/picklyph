import { formatManilaDateTime, type RentalRequest } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Text } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { requestRental, type RentalFailure } from './client';
import { rentalServices } from './live';
import { RentalError } from './ui';
import { useRetryWait } from './useRetryWait';
import { rentalCelebrations } from './celebration';

/** Used in history and selection, so a lost response is recoverable after navigation, sign-in or restart. */
export function useAttempt(actor: string) {
  const services = useMemo(() => rentalServices(actor), [actor]);
  const [attempt, setAttempt] = useState<RentalRequest | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useFocusEffect(useCallback(() => {
    void revision; // Re-read durable intent after each command, not just focus.
    let active = true; setChecked(false); setError(null);
    void services.journal.read().then((saved) => { if (active) { setAttempt(saved); setChecked(true); } },
      () => { if (active) { setError('Couldn’t read reservation recovery. Try again before starting another reservation.'); setChecked(true); } });
    return () => { active = false; };
  }, [services, revision]));
  return { ...services, actor, attempt, checked, error, refresh: () => setRevision((v) => v + 1) };
}
export function Recovery({ recovery }: { recovery: ReturnType<typeof useAttempt> }) {
  const [busy, setBusy] = useState(false); const [failure, setFailure] = useState<RentalFailure | null>(null);
  const [error, setError] = useState<string | null>(null); const lock = useRef(false); const alive = useRef(false);
  const wait = useRetryWait(failure);
  useFocusEffect(useCallback(() => { alive.current = true; return () => { alive.current = false; }; }, []));
  if (!recovery.checked) return <Text style={screenText.body}>Checking reservation recovery…</Text>;
  if (recovery.error) return <Card><Text style={screenText.body}>{recovery.error}</Text><Button label="Retry recovery check" onPress={recovery.refresh} /></Card>;
  if (!recovery.attempt) return failure ? <RentalError failure={failure} /> : null;
  const attempt = recovery.attempt;
  const retry = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setFailure(null); setError(null);
    try {
      const result = await recovery.journal.run(attempt, (command) => requestRental(recovery.transport, command));
      if (!alive.current) return;
      if (result.ok) {
        rentalCelebrations.requested(recovery.actor, result.value.booking);
        router.push({ pathname: '/rental/booking/[id]', params: { id: result.value.booking.id } });
      }
      else setFailure(result.failure);
      recovery.refresh();
    } catch { if (alive.current) setError('Couldn’t finish recovery. The original request remains saved; retry it before reserving again.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return <Card><Text style={screenText.title}>Check your original reservation.</Text>
    <Text style={screenText.body}>An earlier request has no confirmed reply. Retry it with the same reference before making another reservation.
      {'\n'}{formatManilaDateTime(attempt.starts_at)} → {formatManilaDateTime(attempt.ends_at)} (Manila)</Text>
    <Text selectable style={screenText.body}>Court: {attempt.court_id}</Text>
    {failure && <RentalError failure={failure} />}{error && <Text accessibilityLiveRegion="polite" style={screenText.body}>{error}</Text>}
    <Button label={wait ? `Retry in ${wait}s` : 'Retry original reservation'} disabled={wait > 0} loading={busy} onPress={() => void retry()} />
  </Card>;
}
