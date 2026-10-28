import type { NextRequest } from 'next/server';
import { externalMcpRoute } from '@/src/lib/kernel/external-mcp-route';

export const dynamic = 'force-dynamic';
export const POST = (request: NextRequest) => externalMcpRoute(request, true);
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
