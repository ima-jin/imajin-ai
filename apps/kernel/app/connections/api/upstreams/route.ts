import type { NextRequest } from 'next/server';
import { appUpstreamRoute } from '@/src/lib/kernel/app-upstream-route';
export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => appUpstreamRoute(request, 'declarations');
export const PUT = (request: NextRequest) => appUpstreamRoute(request, 'declarations');
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
