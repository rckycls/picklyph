import { handleOwnershipDecision } from '@/lib/ownership-handler';
export const POST = (request: Request) => handleOwnershipDecision(request);
