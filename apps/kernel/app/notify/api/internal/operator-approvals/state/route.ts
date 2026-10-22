import { NextRequest, NextResponse } from 'next/server';
import { requireInternalApiKey } from '@/src/lib/auth/require-internal-api-key';
import { reportApprovalSourceState } from '@/src/lib/notify/approval-expiry';
import { z } from 'zod';

const sourceState = z.object({
  proposalId: z.string().trim().min(1),
  state: z.enum(['gone', 'superseded']),
}).strict();

/** Source truth only, protected by the same internal credential as markApplied. */
export async function POST(request: NextRequest) {
  const denied = await requireInternalApiKey(request);
  if (denied) return denied;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = sourceState.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'proposalId and state (gone or superseded) are required' }, { status: 400 });
  }
  try {
    const ok = await reportApprovalSourceState(parsed.data.proposalId, parsed.data.state);
    return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
  } catch {
    return NextResponse.json({ error: 'Unable to record source state' }, { status: 500 });
  }
}
