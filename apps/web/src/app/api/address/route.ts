import { handleLookup } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleLookup(request);
