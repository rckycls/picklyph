import { formatManilaDateTime, formatPhpCentavos, readRentalCommand, toManilaDateTime,
  type RentalBooking, type RentalOwnerEntry, type RentalQuote } from '@picklyph/domain';
import { randomUUID } from 'expo-crypto';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { screenText } from '@/components/ui/Screen';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { loadQuote } from '../rental/client';
import { createGeneration, defaultRentalDate, rentalWindow } from '../rental/model';
import { deskFailureMessage, enterOutsideRental, type DeskFailure } from './deskClient';
import { deskServices } from './deskLive';
import { OwnerScreen } from './OwnerScreen';

/** Owners record a phone/chat/counter booking in the shared inventory. Same quote, hours and conflict checks as a player rental; confirmed on entry. */
export function OutsideRental({ actor, venueId }: { actor: string; venueId: string }) {
  const { transports, journal } = useMemo(() => deskServices(actor), [actor]);
  const [venue, setVenue] = useState<VenueDetail | null>(null); const [court, setCourt] = useState('');
  const [date, setDate] = useState(defaultRentalDate); const [time, setTime] = useState('18:00'); const [duration, setDuration] = useState('60');
  const [guest, setGuest] = useState(''); const [quote, setQuote] = useState<RentalQuote | null>(null);
  const [saved, setSaved] = useState<RentalOwnerEntry | null>(null); const [recorded, setRecorded] = useState<RentalBooking | null>(null);
  const [busy, setBusy] = useState<'quote' | 'record' | null>(null); const [failure, setFailure] = useState<DeskFailure | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useMemo(() => createGeneration(), []); const lock = useRef(false); const alive = useRef(false);
  const recheck = useCallback(() => { void journal.read().then((s) => { if (alive.current) setSaved(s); }, () => { if (alive.current) setMessage('Couldn’t read the saved outside booking on this device.'); }); }, [journal]);
  useFocusEffect(useCallback(() => {
    alive.current = true; const abort = new AbortController(); generation.next(); setQuote(null); recheck();
    void loadLiveVenueDetail(venueId, abort.signal).then((v) => {
      if (abort.signal.aborted) return;
      setVenue(v); setCourt((previous) => v?.courts.some((c) => c.id === previous) ? previous : v?.courts[0]?.id ?? '');
    }).catch(() => { if (!abort.signal.aborted) setMessage('Couldn’t load the venue’s courts. Go back and try again.'); });
    return () => { alive.current = false; abort.abort(); generation.next(); };
  }, [venueId, generation, recheck]));
  const edit = (setter: (v: string) => void, value: string) => { generation.next(); setQuote(null); setFailure(null); setMessage(null); setter(value); };
  const review = async () => {
    if (lock.current) return;
    let window;
    try { window = rentalWindow(court, date, time, duration); } catch { setMessage('Use a Manila date, an HH:mm start on the hour or half hour, and 60–1440 minutes in 30-minute steps.'); return; }
    lock.current = true; setBusy('quote'); setFailure(null); setMessage(null); const version = generation.next();
    try {
      const result = await loadQuote(transports.rental, window);
      if (!alive.current || !generation.current(version)) return;
      if (result.ok && result.value.venue_id === venueId) setQuote(result.value);
      else setFailure(result.ok ? { kind: 'unavailable', retryAfterSeconds: null } : result.failure);
    } finally { lock.current = false; if (alive.current) setBusy(null); }
  };
  const send = async (command: RentalOwnerEntry) => {
    if (lock.current) return;
    lock.current = true; setBusy('record'); setFailure(null); setMessage(null);
    try {
      const result = await journal.run(command, (c) => enterOutsideRental(transports, c));
      if (!alive.current) return;
      setQuote(null);
      if (result.ok) { setRecorded(result.value.booking); setGuest(''); } else setFailure(result.failure);
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : 'Couldn’t record the outside booking.'); }
    finally { lock.current = false; recheck(); if (alive.current) setBusy(null); }
  };
  const record = () => {
    if (!quote) return;
    let command: RentalOwnerEntry;
    try {
      command = readRentalCommand({ kind: 'owner_entry', court_id: quote.court_id, starts_at: quote.starts_at, ends_at: quote.ends_at,
        request_id: randomUUID(), guest_name: guest, expected_quote: quote.expected_quote }) as RentalOwnerEntry;
    } catch { setMessage('Enter who the booking is for: 1–60 characters.'); return; }
    void send(command);
  };
  const courtName = (id: string) => venue?.courts.find((c) => c.id === id)?.name ?? 'Court';
  const blocked = Boolean(busy) || Boolean(saved);
  return <OwnerScreen>
    <Text style={screenText.title}>Record an outside booking</Text>
    <Text style={screenText.body}>For bookings taken by phone, chat or at the counter. It takes the court in the same calendar players book from, is confirmed straight away and is paid at the venue.</Text>
    {saved && <Card tone="highlight">
      <Text style={screenText.label}>Unconfirmed outside booking</Text>
      <Text style={screenText.body}>{saved.guest_name} · {courtName(saved.court_id)} · {formatManilaDateTime(saved.starts_at)} → {formatManilaDateTime(saved.ends_at)}</Text>
      <Text style={screenText.body}>The last attempt has no confirmed result. Retry it to check safely; it can never book the court twice.</Text>
      <Button label="Retry original outside booking" loading={busy === 'record'} disabled={Boolean(busy)} onPress={() => void send(saved)} />
    </Card>}
    {recorded && <Card>
      <Text style={screenText.label}>Recorded · confirmed</Text>
      <Text style={screenText.body}>{recorded.guest_name} · {courtName(recorded.allocation.court_id)}{'\n'}{formatManilaDateTime(recorded.allocation.starts_at)} → {formatManilaDateTime(recorded.allocation.ends_at)}
        {'\n'}{formatPhpCentavos(recorded.snapshot.total_centavos)} due at the venue</Text>
      <Button label="Open that day at the front desk" variant="secondary" onPress={() => router.replace({ pathname: '/owner/desk/[id]',
        params: { id: venueId, date: toManilaDateTime(recorded.allocation.starts_at).date } })} />
    </Card>}
    {venue && <Card>
      <Text style={screenText.label}>Court</Text>
      <View style={{ gap: 8 }}>{venue.courts.map((c) => <Button key={c.id} label={`${court === c.id ? 'Selected · ' : ''}${c.name}`} variant={court === c.id ? 'accent' : 'secondary'}
        accessibilityLabel={`${c.name}${court === c.id ? ', selected' : ''}`} disabled={blocked} onPress={() => edit(setCourt, c.id)} />)}</View>
      <Field label="Date in Manila" hint="YYYY-MM-DD · within the next 60 days" value={date} editable={!blocked} onChangeText={(v) => edit(setDate, v)} />
      <Field label="Start time in Manila" hint="24-hour HH:mm · :00 or :30, still in the future" value={time} editable={!blocked} onChangeText={(v) => edit(setTime, v)} />
      <Field label="Duration in minutes" hint="Minimum 60 · multiples of 30" value={duration} keyboardType="number-pad" editable={!blocked} onChangeText={(v) => edit(setDuration, v)} />
      <Field label="Booking for" hint="Name or note shown only to venue owners · up to 60 characters" value={guest} maxLength={60} autoCapitalize="words"
        editable={!blocked} onChangeText={setGuest} />
      <Button label="Check price and court hours" variant="secondary" loading={busy === 'quote'} disabled={blocked || !court} onPress={() => void review()} />
    </Card>}
    {quote && <Card tone="highlight">
      <Text style={screenText.title}>{formatPhpCentavos(quote.total_centavos)} · {courtName(quote.court_id)}</Text>
      <Text style={screenText.body}>{formatManilaDateTime(quote.starts_at)} → {formatManilaDateTime(quote.ends_at)} (Manila) · {quote.duration_minutes} minutes</Text>
      <Text style={screenText.body}>Saved with the booking at today’s rates. The court is only taken when you record it; an overlap with another booking, block or session is refused.</Text>
      <Button label="Record outside booking" variant="accent" loading={busy === 'record'} disabled={blocked || !guest.trim()} onPress={record} />
    </Card>}
    {failure && <Card><Text accessibilityLiveRegion="polite" style={screenText.body}>{deskFailureMessage(failure)}</Text></Card>}
    {message && <Text accessibilityLiveRegion="polite" style={screenText.body}>{message}</Text>}
    <Button label="Front desk" variant="secondary" onPress={() => router.replace({ pathname: '/owner/desk/[id]', params: { id: venueId } })} />
  </OwnerScreen>;
}
