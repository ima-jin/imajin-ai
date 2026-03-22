import { NextRequest, NextResponse } from 'next/server';
import { db, bugReports } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { isAdmin } from '@/lib/session-auth';

// GET /api/bugs/admin — list all bug reports (admin only)
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;
  if (!isAdmin(identity)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get('status');

  const query = db.select().from(bugReports);

  const reports = statusFilter
    ? await query.where(eq(bugReports.status, statusFilter)).orderBy(desc(bugReports.createdAt))
    : await query.orderBy(desc(bugReports.createdAt));

  return NextResponse.json(reports);
}
