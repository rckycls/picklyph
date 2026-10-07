import { useAuth } from '@/features/auth/AuthProvider';
import { RentalHistory } from '@/features/rental/History';

export default function BookingsScreen() {
  const auth = useAuth();
  return auth.status === 'ready' && auth.session ? <RentalHistory key={auth.session.user.id} actor={auth.session.user.id} /> : null;
}
