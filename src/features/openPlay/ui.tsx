import { formatManilaDateTime, formatPhpCentavos, type SessionBooking, type SessionBookingSnapshot, type SessionOffer } from '@picklyph/domain';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Text } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { VenueDetail } from '@/features/discovery/venueDetail';
import { groupFailureMessage, type GroupFailure } from './client';
import { groupStatus } from './model';

type Snapshot = SessionOffer['snapshot'] | SessionBookingSnapshot;

export function GroupError({ failure }: { failure: GroupFailure }) {
  return <Card><Text accessibilityLiveRegion="polite" style={screenText.body}>{groupFailureMessage(failure)}</Text>
    {failure.kind === 'sign_in' && <Button label="Recover sign-in" onPress={() => router.navigate('/account')} />}
    {failure.kind === 'rejected' && failure.reason === 'already_booked' && <Button label="Open your open-play bookings" variant="secondary"
      onPress={() => router.navigate({ pathname: '/bookings', params: { view: 'play' } })} />}</Card>;
}
/** Court names come from the current public listing; the snapshot keeps the original court IDs. */
export function courtNames(snapshot: Snapshot, venue: VenueDetail | null): string {
  const names = snapshot.court_ids.map((id) => venue?.courts.find((c) => c.id === id)?.name);
  return names.every(Boolean) ? names.join(', ') : `${snapshot.court_ids.length} ${snapshot.court_ids.length === 1 ? 'court' : 'courts'}`;
}
export function SessionTimes({ snapshot, venue }: { snapshot: Snapshot; venue: VenueDetail | null }) {
  return <Text style={screenText.body}>{formatManilaDateTime(snapshot.starts_at)} → {formatManilaDateTime(snapshot.ends_at)}
    {'\n'}Asia/Manila · {courtNames(snapshot, venue)}</Text>;
}
function PolicyNotes({ snapshot }: { snapshot: Snapshot }) {
  return <>
    <Text style={screenText.label}>Pay at the venue · no online charge</Text>
    <Text style={screenText.body}>{snapshot.policy.confirmation === 'approval'
      ? 'Venue approval required. Your request holds your group’s spots for up to 2 hours, capped at the session start. It is confirmed only if the venue accepts before the hold ends.'
      : 'Instant confirmation if the server still has enough spots when you reserve.'}</Text>
    <Text style={screenText.body}>Selected payment: arrival. Venue payment options: {snapshot.policy.payment === 'both' ? 'arrival or online' : snapshot.policy.payment}.
      {'\n'}You can cancel the whole group before the session starts. The saved policy has a 24-hour refund cutoff; this unpaid arrival group has no online payment to refund.
      {'\n'}To change names, cancel and reserve again.</Text>
  </>;
}
/** Full total for named participants: the immutable per-person price × names, as the server will check it. */
export function GroupReview({ snapshot, names, total }: { snapshot: Snapshot; names: readonly string[]; total: number }) {
  return <Card tone="highlight">
    <Text accessibilityRole="header" style={screenText.title}>Full group total · {formatPhpCentavos(total)}</Text>
    <Text style={screenText.body}>{names.length} {names.length === 1 ? 'person' : 'people'} × {formatPhpCentavos(snapshot.price_centavos)} per person</Text>
    <Text style={screenText.body}>{names.map((name, i) => `${i + 1}. ${name}`).join('\n')}</Text>
    <Text style={screenText.body}>{formatManilaDateTime(snapshot.starts_at)} → {formatManilaDateTime(snapshot.ends_at)} (Manila)</Text>
    <PolicyNotes snapshot={snapshot} />
  </Card>;
}
export function GroupSummary({ booking, children }: { booking: SessionBooking; children?: ReactNode }) {
  const status = groupStatus(booking);
  return <Card>{children}<StatusBadge label={status.label} tone={status.tone} />
    <Text style={screenText.body}>{status.text}</Text>
    {booking.source === 'walk_in' && <Text style={screenText.body}>The venue entered this group in person.</Text>}
    <Text style={screenText.label}>{booking.status === 'pending' || booking.status === 'confirmed'
      ? 'Payment: unpaid · pay at venue' : 'Payment record: unpaid · no online charge'}</Text>
    <Text selectable style={screenText.body}>Booking reference: {booking.id}</Text>
    {booking.status === 'pending' && booking.expires_at && <Text style={screenText.body}>Hold ends: {formatManilaDateTime(booking.expires_at)} (Manila). Refresh to check the server’s current status.</Text>}
  </Card>;
}
