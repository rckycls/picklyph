import { handleRegister } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleRegister(request);
