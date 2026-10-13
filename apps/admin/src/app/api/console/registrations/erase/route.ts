import { handleRegistrationBatch } from '@/lib/registrations-handler';
export const POST = (request: Request) => handleRegistrationBatch(request, 'erase');
