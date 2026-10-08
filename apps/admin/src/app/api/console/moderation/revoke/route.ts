import { handleOwnershipRevocation } from '@/lib/moderation-handler';
export const POST = (request: Request) => handleOwnershipRevocation(request);
