import type { NextRequest } from 'next/server';
import { appUpstreamRoute } from '@/src/lib/kernel/app-upstream-route';
export const dynamic = 'force-dynamic';
export const POST = (request: NextRequest) => appUpstreamRoute(request, 'call');
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
