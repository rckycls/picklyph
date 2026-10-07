import { VerifiedOwnerGate } from '@/features/owner/OwnerMode';
import { OwnedVenuesScreen } from '@/app/owner/venues';

export default function OwnerTab() {
  return <VerifiedOwnerGate><OwnedVenuesScreen includeTop /></VerifiedOwnerGate>;
}
