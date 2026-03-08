import { NextRequest, NextResponse } from 'next/server';
import { db, bugReports } from '@/db';
import { eq, desc } from 'drizzle-orm';
import { authenticateRequest, isAdmin } from '@/lib/session-auth';

// GET /api/bugs/admin — list all bug reports (admin only)
export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth.authenticated || !auth.identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdmin(auth.identity)) {
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
