import type { NextRequest } from 'next/server';
import { readAppPodMembership } from '@/src/lib/kernel/app-pod-membership';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  return readAppPodMembership(request);
}
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
