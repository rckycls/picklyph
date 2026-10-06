import { handleAuthPost } from '@/lib/auth-handler';
export async function POST(request: Request) { return handleAuthPost(request, 'request'); }
