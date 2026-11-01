import { NextResponse } from 'next/server';
import { authenticateLeaseReader, effectiveOperatorApprovalsLease } from '@/src/lib/auth/operator-approvals-lease';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

/** POST is a read: its body carries the agent's signed, operation-bound message. */
export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers });
  }
  try {
    const agentDid = await authenticateLeaseReader(raw);
    if (!agentDid) return NextResponse.json({ error: 'Agent DID signature required' }, { status: 401, headers });
    const lease = await effectiveOperatorApprovalsLease(agentDid);
    return NextResponse.json({ lease }, { headers });
  } catch {
    return NextResponse.json({ error: 'Lease lookup failed' }, { status: 503, headers });
  }
}
