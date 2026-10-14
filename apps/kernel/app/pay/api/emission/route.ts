/**
 * Closed legacy endpoint. Protocol emissions run only inside the kernel.
 * No shared key, app scope, or user credential grants HTTP mint authority.
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';

export function POST(request: NextRequest) {
  return NextResponse.json(
    { error: 'Emission is kernel-internal only' },
    { status: 403, headers: corsHeaders(request) },
  );
}
