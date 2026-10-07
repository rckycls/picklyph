import { type RentalQuote } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { loadQuote, requestRental, type RentalFailure } from './client';
import { createGeneration, defaultRentalDate, rentalWindow, reviewedRequest } from './model';
import { Recovery, useAttempt } from './Recovery';
import { PriceReview, RentalError } from './ui';
import { useRetryWait } from './useRetryWait';

export function RentalSelection({ actor, venueId }: { actor: string; venueId: string }) {
  const recovery = useAttempt(actor); const { transport, journal } = recovery;
  const [venue, setVenue] = useState<VenueDetail | null>(null); const [detailBusy, setDetailBusy] = useState(true);
  const [detailError, setDetailError] = useState(false); const [detailRevision, setDetailRevision] = useState(0);
  const [court, setCourt] = useState(''); const [date, setDate] = useState(defaultRentalDate);
  const [time, setTime] = useState('18:00'); const [duration, setDuration] = useState('60');
  const [quote, setQuote] = useState<RentalQuote | null>(null); const [busy, setBusy] = useState<'quote' | 'request' | null>(null);
  const [failure, setFailure] = useState<RentalFailure | null>(null); const [message, setMessage] = useState<string | null>(null);
  const wait = useRetryWait(failure);
  const generation = useMemo(() => createGeneration(), []); const lock = useRef(false); const focused = useRef(false);
  useFocusEffect(useCallback(() => {
    void detailRevision; // Explicit reload key as well as focus/identity invalidation.
    focused.current = true; const abort = new AbortController(); generation.next(); setQuote(null); setDetailBusy(true); setDetailError(false);
    void loadLiveVenueDetail(venueId, abort.signal).then((v) => {
      if (abort.signal.aborted) return;
      setVenue(v); setCourt((previous) => v?.courts.some((c) => c.id === previous) ? previous : v?.courts[0]?.id ?? ''); setDetailBusy(false);
    }).catch(() => { if (!abort.signal.aborted) { setDetailError(true); setDetailBusy(false); } });
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') { generation.next(); setQuote(null); setDetailRevision((v) => v + 1); }
    });
    return () => { focused.current = false; abort.abort(); generation.next(); setQuote(null); listener.remove(); };
  }, [venueId, detailRevision, generation]));
  const edit = (setter: (v: string) => void, value: string) => { generation.next(); setQuote(null); setFailure(null); setMessage(null); setter(value); };
  const review = async () => {
    if (lock.current) return;
    setQuote(null); setFailure(null); setMessage(null);
    let window;
    try { window = rentalWindow(court, date, time, duration); } catch { setMessage('Use a valid Manila date, HH:mm start on the hour or half hour, and 60–1440 minutes in 30-minute increments.'); return; }
    lock.current = true; setBusy('quote'); const version = generation.next();
    try {
      const result = await loadQuote(transport, window);
      if (!focused.current || !generation.current(version)) return;
      if (result.ok && result.value.venue_id === venueId) setQuote(result.value);
      else setFailure(result.ok ? { kind: 'unavailable', retryAfterSeconds: null } : result.failure);
    } finally { lock.current = false; if (focused.current) setBusy(null); }
  };
  const reserve = async () => {
    if (!quote || lock.current) return;
    const reviewed = quote; lock.current = true; setBusy('request'); setFailure(null); setMessage(null);
    try {
      const result = await journal.run(reviewedRequest(reviewed, randomUUID()), (command) => requestRental(transport, command));
      if (!focused.current) return;
      setQuote(null); recovery.refresh();
      if (result.ok) router.push({ pathname: '/rental/booking/[id]', params: { id: result.value.booking.id } });
      else setFailure(result.failure);
    } catch { if (focused.current) { setQuote(null); setMessage('Couldn’t confirm the reservation. Check original-request recovery before trying again.'); recovery.refresh(); } }
    finally { lock.current = false; if (focused.current) setBusy(null); }
  };
  const blocked = Boolean(busy) || wait > 0 || !recovery.checked || Boolean(recovery.attempt || recovery.error);
  return <OwnerScreen><Text style={screenText.title}>{venue?.name ?? 'Reserve a court'}</Text>
    <Text style={screenText.body}>Choose a court and Manila time, then review the server’s full price and policy. Availability is checked when you reserve.</Text>
    <Recovery recovery={recovery} />
    {detailBusy ? <Text style={screenText.body}>Loading current courts…</Text> : detailError ? <Card>
      <Text style={screenText.body}>Couldn’t load current courts.</Text><Button label="Retry courts" onPress={() => setDetailRevision((v) => v + 1)} /></Card>
      : !venue || venue.claim_status !== 'verified' || venue.courts.length === 0 ? <Text style={screenText.body}>This venue currently has no courts accepting rental selections.</Text>
      : <><Card><Text style={screenText.title}>Court & time</Text>
        <View style={{ gap: 8 }}>{venue.courts.map((c) => <Button key={c.id} label={`${court === c.id ? 'Selected · ' : ''}${c.name}`}
          accessibilityLabel={`${c.name}${court === c.id ? ', selected' : ''}`} variant={court === c.id ? 'accent' : 'secondary'} disabled={blocked}
          onPress={() => edit(setCourt, c.id)} />)}</View>
        <Field label="Date in Manila" hint="YYYY-MM-DD · start within the next 60 days" placeholder="2026-10-09" value={date} editable={!blocked} onChangeText={(v) => edit(setDate, v)} />
        <Field label="Start time in Manila" hint="24-hour HH:mm · :00 or :30" placeholder="18:00" value={time} editable={!blocked} onChangeText={(v) => edit(setTime, v)} />
        <Field label="Duration in minutes" hint="Minimum 60 · multiples of 30 · maximum 1440" value={duration} keyboardType="number-pad" editable={!blocked} onChangeText={(v) => edit(setDuration, v)} />
        <Button label={wait ? `Review again in ${wait}s` : 'Review price & policy'} loading={busy === 'quote'} disabled={blocked} onPress={() => void review()} /></Card>
        {quote && <><Text style={screenText.label}>{venue.courts.find((c) => c.id === quote.court_id)?.name}</Text><PriceReview value={quote} />
          <Button label={quote.policy.confirmation === 'approval' ? 'Request approval · pay at venue' : 'Reserve · pay at venue'} variant="accent"
            disabled={blocked} loading={busy === 'request'} onPress={() => void reserve()} /></>}
      </>}
    {failure && <RentalError failure={failure} />}{message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
    <Button label="Your bookings" variant="secondary" onPress={() => router.navigate('/bookings')} />
  </OwnerScreen>;
}
