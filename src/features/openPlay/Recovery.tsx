import { formatPhpCentavos, type SessionBookingRequest } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Text } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { rentalCelebrations } from '../rental/celebration';
import { useRetryWait } from '../rental/useRetryWait';
import { requestGroup, type GroupFailure } from './client';
import { openPlayServices } from './live';
import { GroupError } from './ui';

/** Used in history and reservation, so a lost reply is recoverable after navigation, sign-in or restart. */
export function useGroupAttempt(actor: string) {
  const services = useMemo(() => openPlayServices(actor), [actor]);
  const [attempt, setAttempt] = useState<SessionBookingRequest | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useFocusEffect(useCallback(() => {
    void revision; // Re-read durable intent after each command, not just focus.
    let active = true; setChecked(false); setError(null);
    void services.journal.read().then((saved) => { if (active) { setAttempt(saved); setChecked(true); } },
      () => { if (active) { setError('Couldn’t read group request recovery. Try again before reserving another group.'); setChecked(true); } });
    return () => { active = false; };
  }, [services, revision]));
  return { ...services, actor, attempt, checked, error, refresh: () => setRevision((v) => v + 1) };
}
export function GroupRecovery({ recovery }: { recovery: ReturnType<typeof useGroupAttempt> }) {
  const [busy, setBusy] = useState(false); const [failure, setFailure] = useState<GroupFailure | null>(null);
  const [error, setError] = useState<string | null>(null); const lock = useRef(false); const alive = useRef(false);
  const wait = useRetryWait(failure);
  useFocusEffect(useCallback(() => { alive.current = true; return () => { alive.current = false; }; }, []));
  if (!recovery.checked) return <Text style={screenText.body}>Checking group request recovery…</Text>;
  if (recovery.error) return <Card><Text style={screenText.body}>{recovery.error}</Text><Button label="Retry recovery check" onPress={recovery.refresh} /></Card>;
  if (!recovery.attempt) return failure ? <GroupError failure={failure} /> : null;
  const attempt = recovery.attempt;
  const retry = async () => {
    if (lock.current) return; lock.current = true; setBusy(true); setFailure(null); setError(null);
    try {
      const result = await recovery.journal.run(attempt, (command) => requestGroup(recovery.transport, command));
      if (!alive.current) return;
      if (result.ok) {
        rentalCelebrations.requested(recovery.actor, result.value.booking);
        router.push({ pathname: '/play/booking/[id]', params: { id: result.value.booking.id } });
      }
      else setFailure(result.failure);
      recovery.refresh();
    } catch { if (alive.current) setError('Couldn’t finish recovery. The original request remains saved; retry it before reserving another group.'); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return <Card><Text style={screenText.title}>Check your original group request.</Text>
    <Text style={screenText.body}>An earlier open-play request has no confirmed reply. Retry it with the same reference and names before reserving another group.</Text>
    <Text style={screenText.body}>{attempt.participants.join(', ')}{'\n'}{attempt.participants.length} {attempt.participants.length === 1 ? 'person' : 'people'} · {formatPhpCentavos(attempt.expected_total_centavos)} at the venue</Text>
    <Text selectable style={screenText.body}>Session: {attempt.session_id}</Text>
    {failure && <GroupError failure={failure} />}{error && <Text accessibilityLiveRegion="polite" style={screenText.body}>{error}</Text>}
    <Button label={wait ? `Retry in ${wait}s` : 'Retry original group request'} disabled={wait > 0} loading={busy} onPress={() => void retry()} />
  </Card>;
}
