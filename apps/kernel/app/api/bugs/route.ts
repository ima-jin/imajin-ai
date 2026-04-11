import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, bugReports } from '@/src/db';
import { eq, desc } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { isAdmin } from '@/src/lib/www/session-auth';
import { withLogger } from '@imajin/logger';

// POST /api/bugs — submit a new bug report
export const POST = withLogger('kernel', async (request, { log }) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { type, description, screenshotUrl, pageUrl, viewport } = body as {
    type?: string;
    description?: string;
    screenshotUrl?: string;
    pageUrl?: string;
    viewport?: string;
  };

  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }

  const validTypes = ['bug', 'suggestion', 'question', 'other'];
  const reportType = validTypes.includes(type ?? '') ? type! : 'bug';

  const userAgent = request.headers.get('user-agent') ?? undefined;

  const [report] = await db.insert(bugReports).values({
    id: `bug_${nanoid(16)}`,
    reporterDid: identity.id,
    reporterName: identity.name ?? null,
    type: reportType,
    description: description.trim(),
    screenshotUrl: typeof screenshotUrl === 'string' ? screenshotUrl : null,
    pageUrl: typeof pageUrl === 'string' ? pageUrl : null,
    userAgent: userAgent ?? null,
    viewport: typeof viewport === 'string' ? viewport : null,
    status: 'new',
  }).returning();

  return NextResponse.json(report, { status: 201 });
});

// GET /api/bugs — list bugs for the authenticated user, or all bugs with ?scope=all
export const GET = withLogger('kernel', async (request, { log }) => {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;

  const url = new URL(request.url);
  const scope = url.searchParams.get('scope');

  if (scope === 'all') {
    // Return all bug reports (no DID filter), but strip reporter details for privacy
    const reports = await db
      .select()
      .from(bugReports)
      .orderBy(desc(bugReports.createdAt));

    return NextResponse.json(reports.map(r => ({
      ...r,
      reporterDid: r.reporterDid === identity.id ? r.reporterDid : undefined,
      reporterName: r.reporterDid === identity.id ? r.reporterName : undefined,
    })));
  }

  const reports = await db
    .select()
    .from(bugReports)
    .where(eq(bugReports.reporterDid, identity.id))
    .orderBy(desc(bugReports.createdAt));

  return NextResponse.json(reports);
});
