import { DEFAULT_GROUP_LIMIT, formatManilaDateTime, formatPhpCentavos,
  type OwnerVenue, type SessionCreate, type SessionPage, type SessionWalkIn } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { colors } from '@/theme/colors';
import { fonts } from '@/theme/typography';
import { addDays, clockLabel, dayTitle, manilaDate } from './calendarModel';
import { OptionStepper } from './FormControls';
import { liveOwnedVenue } from './liveOwner';
import { OwnerScreen } from './OwnerScreen';
import { cancelSession, createSession, listSessions, sessionFailureMessage } from './sessionClient';
import { sessionServices } from './sessionLive';
import { sessionDraft } from './sessionDraft';
import { SessionWalkIns } from './SessionWalkIns';
import { venueFailureMessage } from './venueClient';
import { addWalkIn, removeWalkIn, walkInFailureMessage } from './walkInClient';

export function SessionScheduler({ venueId, actor }: { venueId: string; actor: string }) {
  const services = useMemo(() => { try { return sessionServices(actor); } catch { return null; } }, [actor]);
  const [venue, setVenue] = useState<OwnerVenue | null>(null); const [page, setPage] = useState<SessionPage | null>(null);
  const [pending, setPending] = useState<SessionCreate | null>(null); const [recoveryReady, setRecoveryReady] = useState(false);
  const [loading, setLoading] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState(0); const [now, setNow] = useState(() => Date.now());
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [walkInPending, setWalkInPending] = useState<SessionWalkIn | null>(null); const [walkInsFor, setWalkInsFor] = useState<string | null>(null);
  const [title, setTitle] = useState('Open play'); const [capacity, setCapacity] = useState('12'); const [group, setGroup] = useState(String(DEFAULT_GROUP_LIMIT));
  const [price, setPrice] = useState('250'); const [selected, setSelected] = useState<string[]>([]);
  const [date, setDate] = useState(() => addDays(manilaDate(Date.now()), 1)); const [start, setStart] = useState(1080); const [end, setEnd] = useState(1200);
  const alive = useRef(true); const working = useRef(false); const request = useRef<AbortController | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (!retryAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [retryAt]);
  const load = useCallback((after: string | null = null) => {
    if (!services || working.current) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setFresh(false); setLoading(true);
    void Promise.all([liveOwnedVenue(venueId, abort.signal), listSessions(services.transport, venueId, after, abort.signal), services.journal.read(),
      services.walkIns.journal.read()]).then(([v, s, saved, savedWalkIn]) => {
      if (abort.signal.aborted || !alive.current) return;
      setLoading(false); setPending(saved); setWalkInPending(savedWalkIn); setRecoveryReady(true);
      if (!v.ok) { setVenue(null); setMessage(venueFailureMessage(v.failure)); return; }
      setVenue(v.value);
      if (!s.ok) { setMessage(sessionFailureMessage(s.failure)); return; }
      setFresh(true);
      setPage(previous => after && previous ? { ...s.value, sessions: [...previous.sessions, ...s.value.sessions].filter((s, i, all) => all.findIndex(x => x.id === s.id) === i) } : s.value);
    }, () => { if (!abort.signal.aborted && alive.current) { setLoading(false); setMessage('Couldn’t load the sessions or saved request. Retry before creating a session.'); } });
  }, [services, venueId]);
  useFocusEffect(useCallback(() => { load(); return () => { request.current?.abort(); }; }, [load]));
  useEffect(() => { const sub = AppState.addEventListener('change', state => { if (state === 'active') load(); }); return () => sub.remove(); }, [load]);
  const disabled = busy || pending !== null; const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const dates = Array.from({ length: 61 }, (_, i) => addDays(page ? manilaDate(page.at) : manilaDate(now), i));
  const starts = Array.from({ length: 48 }, (_, i) => i * 30);
  const ends = Array.from({ length: 48 }, (_, i) => start + (i + 1) * 30);
  const send = async () => {
    if (!services || working.current || wait || !recoveryReady || !fresh) return;
    let command = pending;
    try {
      if (!command) command = sessionDraft({ venueId, requestId: randomUUID(), courts: selected, title, date, start, end, capacity, group, price });
    } catch { setMessage('Check the title, selected courts, capacity, group limit and peso price.'); return; }
    working.current = true; setBusy(true); setMessage(null); setPending(command);
    try {
      const outcome = await services.journal.run(command, original => createSession(services.transport, original));
      if (!alive.current) return;
      if (outcome.ok) { setPending(null); setMessage(outcome.value.session.status === 'cancelled' ? 'The original session was already cancelled.' : 'Session scheduled. Its selected courts are reserved.'); }
      else {
        setMessage(sessionFailureMessage(outcome.failure)); setRetryAt(Date.now() + (outcome.failure.retryAfterSeconds ?? 0) * 1000); setNow(Date.now());
        setPending(await services.journal.read());
      }
    } catch { if (alive.current) setMessage('Couldn’t confirm this session. Keep the original request and retry.'); }
    finally { working.current = false; if (alive.current) { setBusy(false); load(); } }
  };
  const cancel = async (id: string) => {
    if (!services || working.current || wait || !fresh) return;
    working.current = true; setBusy(true); setMessage(null);
    try {
      const outcome = await cancelSession(services.transport, id);
      if (!alive.current) return;
      setMessage(outcome.ok ? 'Session cancelled. Its courts are available again.' : sessionFailureMessage(outcome.failure));
      if (!outcome.ok) { setRetryAt(Date.now() + (outcome.failure.retryAfterSeconds ?? 0) * 1000); setNow(Date.now()); }
    } finally { working.current = false; if (alive.current) { setBusy(false); setConfirmCancel(null); load(); } }
  };
  // Walk-ins use the same durable journal pattern: the original key and names are saved before dispatch and retried unchanged.
  const sendWalkIn = async (input: SessionWalkIn | null): Promise<boolean> => {
    const command = input ?? walkInPending;
    if (!services || !command || working.current || wait || !recoveryReady || !fresh) return false;
    working.current = true; setBusy(true); setMessage(null); setWalkInPending(command);
    try {
      const outcome = await services.walkIns.journal.run(command, original => addWalkIn(services.walkIns.transport, original));
      if (!alive.current) return false;
      if (outcome.ok) {
        const b = outcome.value.booking; setWalkInPending(null);
        setMessage(b.status === 'cancelled' ? 'This walk-in was already added and later removed.'
          : `Walk-in added: ${b.spots} ${b.spots === 1 ? 'person' : 'people'} · ${formatPhpCentavos(b.snapshot.total_centavos)} due on arrival.`);
        return true;
      }
      setMessage(walkInFailureMessage(outcome.failure)); setRetryAt(Date.now() + (outcome.failure.retryAfterSeconds ?? 0) * 1000); setNow(Date.now());
      setWalkInPending(await services.walkIns.journal.read()); return false;
    } catch { if (alive.current) setMessage('Couldn’t confirm this walk-in. Keep the original names and retry.'); return false; }
    finally { working.current = false; if (alive.current) { setBusy(false); load(); } }
  };
  const removeWalk = async (bookingId: string) => {
    if (!services || working.current || wait || !fresh) return;
    working.current = true; setBusy(true); setMessage(null);
    try {
      const outcome = await removeWalkIn(services.walkIns.transport, bookingId);
      if (!alive.current) return;
      setMessage(outcome.ok ? 'Walk-in removed. Its spots are open again.' : walkInFailureMessage(outcome.failure));
      if (!outcome.ok) { setRetryAt(Date.now() + (outcome.failure.retryAfterSeconds ?? 0) * 1000); setNow(Date.now()); }
    } finally { working.current = false; if (alive.current) { setBusy(false); load(); } }
  };
  const canCreate = venue?.publication_status === 'approved' && venue.claim_status === 'verified';
  const walkInPendingSession = walkInPending && page?.sessions.find(s => s.id === walkInPending.session_id);
  return <OwnerScreen>
    <Card>
      <Text accessibilityRole="header" style={screenText.title}>{venue?.name ?? 'Open-play sessions'}</Text>
      <Text style={screenText.body}>Set a per-person price and reserve one or more courts for open play. All times are Philippine time.</Text>
      <Button label="Reload sessions" variant="secondary" disabled={loading || busy} onPress={() => load()} />
      {loading && <ActivityIndicator accessibilityLabel="Loading sessions" color={colors.primary} />}
      {message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
    </Card>
    {pending && <Card>
      <Text accessibilityRole="header" style={screenText.title}>Check your original request</Text>
      <Text style={screenText.body}>{pending.title} · {formatManilaDateTime(pending.starts_at)} · {formatPhpCentavos(pending.price_centavos)} per person</Text>
      {pending.venue_id !== venueId && <Text style={screenText.body}>This saved request is for another venue. Retry it here before creating another session.</Text>}
      <Button label={wait ? `Retry in ${wait}s` : 'Retry original session'} loading={busy} disabled={busy || loading || !!wait || !fresh} onPress={() => void send()} />
    </Card>}
    {walkInPending && <Card>
      <Text accessibilityRole="header" style={screenText.title}>Check your saved walk-in</Text>
      <Text style={screenText.body}>{walkInPending.participants.join(', ')} · {formatPhpCentavos(walkInPending.expected_total_centavos)}
        {walkInPendingSession ? ` · ${walkInPendingSession.snapshot.title}, ${formatManilaDateTime(walkInPendingSession.snapshot.starts_at)}` : ''}</Text>
      <Text style={screenText.body}>Retry the original names to confirm whether they were added. Other walk-ins wait until this is resolved.</Text>
      <Button label={wait ? `Retry in ${wait}s` : 'Retry original walk-in'} loading={busy} disabled={busy || loading || !!wait || !fresh} onPress={() => void sendWalkIn(null)} />
    </Card>}
    {venue && !canCreate && <Card><Text style={screenText.body}>Session scheduling needs a published venue with verified ownership.</Text></Card>}
    {canCreate && !pending && <Card>
      <Text accessibilityRole="header" style={screenText.title}>Schedule open play</Text>
      <Field label="Session title" value={title} onChange={setTitle} disabled={disabled} maxLength={80} />
      <OptionStepper label="Date" options={dates} value={date} format={dayTitle} onChange={setDate} disabled={disabled} jump={7} jumpLabel="7 days" />
      <OptionStepper label="Start" options={starts} value={start} format={clockLabel} onChange={v => { setStart(v); setEnd(Math.min(v + 1440, Math.max(v + 30, end))); }} disabled={disabled} />
      <OptionStepper label="End" options={ends} value={end} format={v => v === 1440 ? '00:00 next day' : clockLabel(v)} onChange={setEnd} disabled={disabled} />
      <Text style={screenText.label}>Courts</Text>
      {venue.courts.filter(c => c.status === 'active').map(c => <Pressable key={c.id} accessibilityRole="checkbox" accessibilityLabel={c.name}
        accessibilityState={{ checked: selected.includes(c.id), disabled }} disabled={disabled}
        onPress={() => setSelected(list => list.includes(c.id) ? list.filter(id => id !== c.id) : [...list, c.id])}
        style={[styles.court, selected.includes(c.id) && styles.selected]}><Text style={screenText.body}>{selected.includes(c.id) ? '✓ ' : ''}{c.name}</Text></Pressable>)}
      <Field label="Participant capacity (1–200)" value={capacity} onChange={value => { setCapacity(value); if (Number(group) > Number(value)) setGroup(String(Math.max(1, Math.min(DEFAULT_GROUP_LIMIT, Number(value))))); }} disabled={disabled} numeric />
      <Field label="Maximum people per group" value={group} onChange={setGroup} disabled={disabled} numeric />
      <Field label="Price per person (PHP)" value={price} onChange={setPrice} disabled={disabled} numeric />
      <Text style={screenText.body}>Current venue policies are saved with this session. Every selected court must be open and free for the full time.</Text>
      <Button label={wait ? `Create in ${wait}s` : 'Create session'} loading={busy} disabled={disabled || !recoveryReady || loading || !fresh || !!wait} onPress={() => void send()} />
    </Card>}
    {page && <>
      <Text style={screenText.body}>{page.sessions.length} sessions loaded{!fresh ? ' · Reload to confirm current status' : ''}. Add walk-ins to a session here; player booking opens in a later update.</Text>
      {[...page.sessions].sort((a, b) => Date.parse(b.snapshot.starts_at) - Date.parse(a.snapshot.starts_at)).map(s => <Card key={s.id}>
        <Text accessibilityRole="header" style={screenText.title}>{s.snapshot.title}</Text>
        <Text style={screenText.body}>{formatManilaDateTime(s.snapshot.starts_at)} → {formatManilaDateTime(s.snapshot.ends_at)}</Text>
        <Text style={screenText.body}>{s.status === 'cancelled' ? 'Cancelled' : 'Scheduled'} · {s.snapshot.court_ids.length} courts · Capacity {s.snapshot.capacity} · Group limit {s.snapshot.group_limit}</Text>
        <Text style={screenText.body}>Courts: {s.snapshot.court_ids.map(id => venue?.courts.find(c => c.id === id)?.name ?? id).join(', ')}</Text>
        <Text style={screenText.body}>{formatPhpCentavos(s.snapshot.price_centavos)} per person · {s.snapshot.policy.confirmation === 'approval' ? 'Owner approval' : 'Instant confirmation'} · {s.snapshot.policy.payment === 'arrival' ? 'Pay on arrival' : s.snapshot.policy.payment === 'online' ? 'Online payment' : 'Online or arrival'}</Text>
        <Text style={screenText.body}>Spots taken: {s.reserved_spots} of {s.snapshot.capacity}</Text>
        {canCreate && s.status === 'scheduled' && Date.parse(s.snapshot.ends_at) > Date.parse(page.at) && <>
          <Button label={walkInsFor === s.id ? 'Hide walk-ins' : 'Walk-ins'} variant="secondary" disabled={!fresh && walkInsFor !== s.id}
            onPress={() => setWalkInsFor(current => current === s.id ? null : s.id)} />
          {walkInsFor === s.id && services && <SessionWalkIns session={s} transport={services.walkIns.transport} refreshKey={page.at}
            disabled={busy || loading || !fresh || !!wait || walkInPending !== null} onAdd={command => sendWalkIn(command)} onRemove={removeWalk} />}
        </>}
        {s.status === 'scheduled' && s.reserved_spots === 0 && Date.parse(s.snapshot.starts_at) > Date.parse(page.at) && <>
          {confirmCancel === s.id ? <>
            <Text style={screenText.body}>Cancel this session and release every assigned court?</Text>
            <Button label="Confirm cancellation" disabled={busy || loading || !!wait || !fresh} onPress={() => void cancel(s.id)} />
            <Button label="Keep session" variant="secondary" disabled={busy} onPress={() => setConfirmCancel(null)} />
          </> : <Button label="Cancel empty session" variant="secondary" disabled={busy || loading || !fresh} onPress={() => setConfirmCancel(s.id)} />}
        </>}
      </Card>)}
      {page.next_cursor && page.sessions.length < 200 && <Button label="Load more sessions" variant="secondary" disabled={loading || busy} onPress={() => load(page.next_cursor)} />}
    </>}
    {!services && <Card><Text style={screenText.body}>Open-play sessions aren’t configured in this build.</Text></Card>}
  </OwnerScreen>;
}
function Field({ label, value, onChange, disabled, numeric = false, maxLength = 18 }: {
  label: string; value: string; onChange: (v: string) => void; disabled: boolean; numeric?: boolean; maxLength?: number;
}) {
  return <View style={styles.field}><Text style={screenText.label}>{label}</Text><TextInput accessibilityLabel={label} value={value}
    onChangeText={onChange} editable={!disabled} keyboardType={numeric ? 'decimal-pad' : 'default'} maxLength={maxLength} style={styles.input} /></View>;
}
const styles = StyleSheet.create({
  field: { gap: 6 }, input: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    color: colors.text, backgroundColor: colors.surface, fontFamily: fonts.medium, fontSize: 16 },
  court: { minHeight: 44, padding: 12, borderWidth: 2, borderColor: colors.border, borderRadius: 12 },
  selected: { borderColor: colors.primary, backgroundColor: colors.selectedBackground },
});
