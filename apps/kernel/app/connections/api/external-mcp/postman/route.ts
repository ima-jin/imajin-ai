import type { NextRequest } from 'next/server';
import { externalMcpRoute } from '@/src/lib/kernel/external-mcp-route';

export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => externalMcpRoute(request);
export const POST = (request: NextRequest) => externalMcpRoute(request);
export const DELETE = (request: NextRequest) => externalMcpRoute(request);
export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
