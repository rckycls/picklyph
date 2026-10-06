import { handleEvidence } from '@/lib/ownership-handler';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleEvidence(request, (await params).id);
}
