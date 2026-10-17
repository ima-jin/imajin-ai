import { NextRequest, NextResponse } from 'next/server';
import { reachStatus } from '@/src/lib/auth/reach-status';
import { authenticateSignedReachStatus, parseSignedReachStatus } from '@/src/lib/auth/reach-status-auth';

export const dynamic = 'force-dynamic';

/** Signed transport reader; OAuth/static-header clients call the same reader via MCP. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string; reachId: string }> },
) {
  const { did: principalDid, reachId } = await params;
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const input = parseSignedReachStatus(raw);
  if (!input) return NextResponse.json({ error: 'Invalid signed status request' }, { status: 400 });
  if (!await authenticateSignedReachStatus(principalDid, reachId, input)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }
  const status = await reachStatus({ principalDid, reachId, requesterDid: input.requesterDid });
  if (!status) return NextResponse.json({ error: 'Reach not found' }, { status: 404 });
  return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
}
