import { NextRequest, NextResponse } from 'next/server';
import { reachStatus } from '@/src/lib/auth/reach-status';
import { authenticateSignedReachStatus, parseSignedReachStatus } from '@/src/lib/auth/reach-status-auth';
import { resolveReachBearer } from '@/src/lib/access/reach-bearer';

export const dynamic = 'force-dynamic';

async function statusResponse(principalDid: string, reachId: string, requesterDid: string) {
  const status = await reachStatus({ principalDid, reachId, requesterDid });
  if (!status) return NextResponse.json({ error: 'Reach not found' }, { status: 404 });
  return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
}

/** HTTP reader: either a signed transcript or this recipient's reach-only bearer. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ did: string; reachId: string }> },
) {
  const { did: principalDid, reachId } = await params;
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    if (!authorization.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Invalid reach credential' }, { status: 401 });
    }
    const credential = await resolveReachBearer(authorization.slice(7), principalDid, 'status');
    if (!credential) return NextResponse.json({ error: 'Invalid reach credential' }, { status: 401 });
    return statusResponse(principalDid, reachId, credential.requesterDid);
  }
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
  return statusResponse(principalDid, reachId, input.requesterDid);
}
