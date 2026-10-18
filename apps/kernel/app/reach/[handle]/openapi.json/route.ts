import { NextRequest, NextResponse } from 'next/server';
import { resolveReachRecipient } from '@/src/lib/access/reach-bearer';
import { reachOpenApi } from '@/src/lib/kernel/reach-openapi';

export const dynamic = 'force-dynamic';

const cors = { 'Access-Control-Allow-Origin': '*' };
const uncached = { ...cors, 'Cache-Control': 'no-store' };

/** Public discovery only: no credential is required or read. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ handle: string }> },
) {
  try {
    const { handle } = await params;
    const principal = await resolveReachRecipient(handle);
    if (!principal) {
      return NextResponse.json({ error: 'Reach recipient not found' }, { status: 404, headers: uncached });
    }
    return NextResponse.json(reachOpenApi(handle, principal), {
      headers: { ...cors, 'Cache-Control': 'public, max-age=60' },
    });
  } catch {
    return NextResponse.json({ error: 'Reach specification unavailable' }, { status: 503, headers: uncached });
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...cors,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    },
  });
}
