import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { db, bugReports } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { authenticateRequest } from '@/lib/session-auth';

// POST /api/bugs — submit a new bug report
export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth.authenticated || !auth.identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { description, screenshotUrl, pageUrl, viewport } = body as {
    description?: string;
    screenshotUrl?: string;
    pageUrl?: string;
    viewport?: string;
  };

  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }

  const userAgent = request.headers.get('user-agent') ?? undefined;

  const [report] = await db.insert(bugReports).values({
    id: `bug_${nanoid(16)}`,
    reporterDid: auth.identity.did,
    reporterName: auth.identity.name ?? null,
    description: description.trim(),
    screenshotUrl: typeof screenshotUrl === 'string' ? screenshotUrl : null,
    pageUrl: typeof pageUrl === 'string' ? pageUrl : null,
    userAgent: userAgent ?? null,
    viewport: typeof viewport === 'string' ? viewport : null,
    status: 'new',
  }).returning();

  return NextResponse.json(report, { status: 201 });
}

// GET /api/bugs — list bugs for the authenticated user
export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth.authenticated || !auth.identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const reports = await db
    .select()
    .from(bugReports)
    .where(eq(bugReports.reporterDid, auth.identity.did))
    .orderBy(desc(bugReports.createdAt));

  return NextResponse.json(reports);
}
