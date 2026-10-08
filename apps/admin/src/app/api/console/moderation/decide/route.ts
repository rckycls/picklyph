import { handleModerationDecision } from '@/lib/moderation-handler';
export const POST = (request: Request) => handleModerationDecision(request);
