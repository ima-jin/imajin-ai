import type { NextRequest } from 'next/server';
import { readAppPodMembership } from '@/src/lib/kernel/app-pod-membership';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return readAppPodMembership(request, id);
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
