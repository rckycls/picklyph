import { router } from 'expo-router';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { SignInForm } from '@/features/auth/SignInForm';

export default function BookingSignInScreen() {
  return <Screen eyebrow="MORE TIME ON COURT" title="Your games start here."
    description="Sign in to keep your bookings together. You can discover courts as a guest.">
    <SignInForm />
    <Button label="Back to Discover" variant="secondary" onPress={() => router.navigate('/(tabs)')} />
  </Screen>;
}
