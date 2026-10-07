import { VerifiedOwnerGate } from '@/features/owner/OwnerMode';
import { OwnedVenuesScreen } from '@/app/owner/venues';

export default function OwnerTab() {
  return <VerifiedOwnerGate allowEmpty><OwnedVenuesScreen includeTop /></VerifiedOwnerGate>;
}
