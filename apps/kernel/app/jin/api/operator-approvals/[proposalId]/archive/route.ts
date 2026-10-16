/**
 * POST /jin/api/operator-approvals/:proposalId/archive — an unsigned,
 * owner-only Inbox preference. Never decides or executes a proposal.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { actAsRefusal } from '@/src/lib/notify/act-as-guard';
import { inboxDidFor } from '@/src/lib/notify/approval-addressing';
import { archiveOperatorApproval } from '@/src/lib/notify/operator-approvals-service';

const log = createLogger('kernel:operator-approvals:archive');

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ proposalId: string }> },
) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const borrowedIdentityRefusal = actAsRefusal(authResult.identity, cors);
  if (borrowedIdentityRefusal) return borrowedIdentityRefusal;
  const operatorDid = inboxDidFor(authResult.identity);
  if (!operatorDid) {
    return NextResponse.json({ error: 'Only the identity a proposal is addressed to may archive it' }, { status: 403, headers: cors });
  }

  const { proposalId } = await props.params;
  try {
    const result = await archiveOperatorApproval({ proposalId, operatorDid });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: cors });
    }
    // The client reloads GET for its reader-scoped archivedAt.
    return NextResponse.json({ ok: true }, { headers: cors });
  } catch (err) {
    log.error({ err: String(err), proposalId, operatorDid }, 'archiveOperatorApproval failed');
    return NextResponse.json({ error: 'Failed to archive proposal' }, { status: 500, headers: cors });
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
