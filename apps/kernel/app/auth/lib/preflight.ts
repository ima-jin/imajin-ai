import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';

/**
 * Shared CORS preflight (OPTIONS) handler for the kernel auth routes.
 *
 * Routes re-export it as their `OPTIONS` handler:
 *
 *   export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
 *
 * Keep that re-export at the end of the route file: at the top it sits at the
 * start of the near-identical sibling route bodies and counts as duplication.
 *
 * Deliberately a plain (non-async) function: it never awaits.
 */
export function preflight(request: NextRequest): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}
