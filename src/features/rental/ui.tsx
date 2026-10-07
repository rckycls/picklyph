import { formatManilaDateTime, formatPhpCentavos, type RentalBooking, type RentalQuote, type RentalSnapshot } from '@picklyph/domain';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Text } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { screenText } from '@/components/ui/Screen';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useAuth } from '@/features/auth/AuthProvider';
import { SignInForm } from '@/features/auth/SignInForm';
import { OwnerScreen } from '@/features/owner/OwnerScreen';
import { colors } from '@/theme/colors';
import { bookingStatus } from './model';
import { rentalFailureMessage, type RentalFailure } from './client';

export function RentalGate({ children }: { children: (actor: string) => ReactNode }) {
  const auth = useAuth();
  if (auth.status === 'restoring') return <OwnerScreen><ActivityIndicator color={colors.primary} accessibilityLabel="Restoring sign-in" /></OwnerScreen>;
  if (auth.status !== 'ready' || !auth.session) return <OwnerScreen><Text style={screenText.title}>Sign in to reserve.</Text>
    <Text style={screenText.body}>Sign in here to continue. Any original reservation request stays saved for its account.</Text><SignInForm /></OwnerScreen>;
  return children(auth.session.user.id);
}
export function RentalError({ failure }: { failure: RentalFailure }) {
  return <Card><Text accessibilityLiveRegion="polite" style={screenText.body}>{rentalFailureMessage(failure)}</Text>
    {failure.kind === 'sign_in' && <Button label="Recover sign-in" onPress={() => router.navigate('/account')} />}</Card>;
}
export function PriceReview({ value }: { value: RentalQuote | RentalSnapshot }) {
  const approval = value.policy.confirmation === 'approval';
  return <Card tone="highlight">
    <Text accessibilityRole="header" style={screenText.title}>Full rental total · {formatPhpCentavos(value.total_centavos)}</Text>
    <Text style={screenText.body}>{formatManilaDateTime(value.starts_at)} → {formatManilaDateTime(value.ends_at)}{ '\n' }Asia/Manila · {value.duration_minutes} minutes</Text>
    {value.bands.map((b) => <Text key={b.starts_at} style={screenText.body}>
      {formatManilaDateTime(b.starts_at)} → {formatManilaDateTime(b.ends_at)}{ '\n' }
      {b.duration_minutes} min at {formatPhpCentavos(b.hourly_centavos)} / hour
    </Text>)}
    <Text style={screenText.label}>Pay at the venue · no online charge</Text>
    <Text style={screenText.body}>{approval
      ? 'Venue approval required. Your request holds the court for up to 2 hours, capped at the start time. Confirmation requires the venue’s acceptance before the hold ends.'
      : 'Instant confirmation if the server can reserve the court at submission.'}</Text>
    <Text style={screenText.body}>Selected payment: arrival. Venue payment options: {value.policy.payment === 'both' ? 'arrival or online' : 'arrival'}.
      {'\n'}You can cancel before play. The saved policy has a 24-hour refund cutoff; this unpaid arrival rental has no online payment to refund.
      {'\n'}To change the time, cancel and reserve again.</Text>
    {!('version' in value) && <Text style={screenText.body}>Price checked by the server at {formatManilaDateTime(value.quoted_at)}. This quote does not hold the court or guarantee availability.</Text>}
  </Card>;
}
export function BookingSummary({ booking }: { booking: RentalBooking }) {
  const status = bookingStatus(booking);
  return <Card><StatusBadge label={status.label} tone={status.tone} />
    <Text style={screenText.body}>{status.text}</Text>
    <Text style={screenText.label}>{booking.status === 'pending' || booking.status === 'confirmed'
      ? 'Payment: unpaid · pay at venue' : 'Payment record: unpaid · no online charge'}</Text>
    <Text selectable style={screenText.body}>Booking reference: {booking.id}</Text>
    {booking.status === 'pending' && booking.allocation.expires_at && <Text style={screenText.body}>Hold ends: {formatManilaDateTime(booking.allocation.expires_at)} (Manila). Refresh to check the server’s current status.</Text>}
  </Card>;
}
