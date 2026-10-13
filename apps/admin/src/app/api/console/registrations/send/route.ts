import { handleRegistrationBatch } from '@/lib/registrations-handler';
// Up to 25 emails, spaced for the provider's rate limit.
export const maxDuration = 120;
export const POST = (request: Request) => handleRegistrationBatch(request, 'send');
