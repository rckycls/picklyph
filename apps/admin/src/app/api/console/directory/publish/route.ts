import { handleDirectoryPost } from '@/lib/directory-handler';
export const POST = (request: Request) => handleDirectoryPost(request, 'publish');
