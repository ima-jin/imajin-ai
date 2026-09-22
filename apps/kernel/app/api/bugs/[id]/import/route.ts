import { NextRequest, NextResponse } from 'next/server';
import { db, bugReports } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { isAdmin } from '@/src/lib/www/session-auth';
import { createLogger } from '@imajin/logger';
import { importBugAsIssue, bugImportConnectorErrorResponse } from '@/src/lib/github/bug-import';

const log = createLogger('kernel');

// POST /api/bugs/[id]/import — create a GitHub issue from a bug report (admin
// only), routed through the GitHub connector (#2184). There is deliberately
// no GITHUB_TOKEN/GITHUB_REPO env fallback here — see lib/github/bug-import.ts.
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;
  if (!isAdmin(identity)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let result;
  try {
    result = await importBugAsIssue(params.id, identity.id);
  } catch (err) {
    const connectorResponse = bugImportConnectorErrorResponse(err);
    if (connectorResponse) return connectorResponse;

    log.error({ err: String(err), bugId: params.id }, 'GitHub connector bug import failed');
    return NextResponse.json({ error: 'Failed to create GitHub issue' }, { status: 502 });
  }

  if (result.status === 'not_found') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (result.status === 'pending') {
    return NextResponse.json(
      { pending: true, proposalId: result.proposalId, message: result.message },
      { status: 202 },
    );
  }

  const [updated] = await db
    .update(bugReports)
    .set({
      status: 'imported',
      tracker: result.tracker,
      externalRef: result.externalRef,
      externalUrl: result.externalUrl,
      reviewedBy: identity.id,
      reviewedAt: new Date(),
    })
    .where(eq(bugReports.id, params.id))
    .returning();

  return NextResponse.json(updated);
}
