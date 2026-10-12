import { handleDirectoryBulk } from '@/lib/directory-handler';
export const POST = (request: Request) => handleDirectoryBulk(request);
