import type { NextRequest } from 'next/server';
import { orgHeldConnectionRoute } from '@/src/lib/kernel/org-held-connection-route';

export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => orgHeldConnectionRoute(request);
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
