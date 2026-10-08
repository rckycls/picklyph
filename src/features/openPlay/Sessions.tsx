import { formatPhpCentavos, type SessionOffer, type SessionOfferPage } from '@picklyph/domain';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { PicklyMascot } from '@/components/mascot/PicklyMascot';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { loadLiveVenueDetail } from '@/features/discovery/liveDirectory';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { useRetryWait } from '../rental/useRetryWait';
import { loadOffers } from './client';
import { openPlayServices } from './live';
import { offerState, spotsLabel } from './model';
import { GroupError, SessionTimes } from './ui';
import { usePages } from './usePages';

type Row = { offer: SessionOffer; at: string };
/** Each row keeps the database time of the page that returned it, so started/full labels never use the device clock. */
const mergeOffers = (rows: Row[], page: SessionOfferPage, after: string | null): Row[] => {
  const fresh = page.sessions.map((offer) => ({ offer, at: page.at }));
  const all = after ? [...rows.filter((r) => !fresh.some((f) => f.offer.id === r.offer.id)), ...fresh] : fresh;
  return all.sort((a, b) => a.offer.snapshot.starts_at.localeCompare(b.offer.snapshot.starts_at) || a.offer.id.localeCompare(b.offer.id));
};

export function SessionList({ actor, venueId }: { actor: string; venueId: string }) {
  const services = useMemo(() => openPlayServices(actor), [actor]);
  const load = useCallback((after: string | null, signal: AbortSignal) => loadOffers(services.transport, venueId, after, signal), [services, venueId]);
  const pages = usePages(load, mergeOffers);
  const wait = useRetryWait(pages.failure);
  const [venue, setVenue] = useState<VenueDetail | null>(null);
  useFocusEffect(useCallback(() => {
    const abort = new AbortController();
    void loadLiveVenueDetail(venueId, abort.signal).then((v) => { if (!abort.signal.aborted) setVenue(v); }).catch(() => {});
    return () => abort.abort();
  }, [venueId]));
  const unavailable = pages.failure?.kind === 'rejected' && pages.failure.reason === 'venue_unavailable';
  return <OwnerScreen><Text style={screenText.title}>{venue?.name ?? 'Open play'}</Text>
    <Text style={screenText.body}>Upcoming open-play sessions. Choose one to add your group’s names and review the full total. Spots are checked again when you reserve.</Text>
    <Button label={wait ? `Refresh in ${wait}s` : pages.busy ? 'Checking sessions…' : 'Refresh sessions'} variant="secondary" loading={pages.busy} disabled={wait > 0} onPress={pages.refresh} />
    {pages.failure && <GroupError failure={pages.failure} />}
    {pages.failure && pages.rows.length > 0 && !unavailable && <Text style={screenText.body}>The list below shows the last received sessions. Refresh to check current spots.</Text>}
    {pages.loaded && pages.rows.length === 0 && !pages.busy && !pages.failure && <Card><View style={{ alignItems: 'center' }}><PicklyMascot size={140} /></View>
      <Text style={screenText.title}>No open play scheduled yet.</Text>
      <Text style={screenText.body}>This venue has no upcoming sessions. You can still reserve a whole court.</Text>
      <Button label="Choose a court & time" variant="accent" onPress={() => router.push({ pathname: '/rental/venue/[id]', params: { id: venueId } })} /></Card>}
    {!unavailable && pages.rows.map(({ offer, at }) => {
      const state = offerState(offer, at); const s = offer.snapshot;
      return <Card key={offer.id}>
        <StatusBadge label={spotsLabel(offer, at)} tone={state === 'open' ? 'success' : 'neutral'} />
        <Text style={screenText.title}>{s.title}</Text>
        <SessionTimes snapshot={s} venue={venue} />
        <Text style={screenText.body}>{formatPhpCentavos(s.price_centavos)} per person · up to {s.group_limit} per group · pay at venue
          {'\n'}{s.policy.confirmation === 'approval' ? 'Venue approval required' : 'Instant confirmation'}</Text>
        <Button label={state === 'open' ? 'Choose session' : 'View session'} variant={state === 'open' ? 'accent' : 'secondary'}
          accessibilityLabel={`${state === 'open' ? 'Choose' : 'View'} ${s.title}, ${spotsLabel(offer, at)}`}
          onPress={() => router.push({ pathname: '/play/session/[id]', params: { id: offer.id } })} />
      </Card>;
    })}
    {pages.cursor && !unavailable && <Button label="Load more sessions" variant="secondary" disabled={pages.busy || wait > 0} onPress={pages.more} />}
    <Button label="Your open-play bookings" variant="secondary" onPress={() => router.navigate({ pathname: '/bookings', params: { view: 'play' } })} />
  </OwnerScreen>;
}
