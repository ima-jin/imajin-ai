import { NextRequest, NextResponse } from 'next/server';
import { db, bugReports } from '@/db';
import { eq } from 'drizzle-orm';
import { authenticateRequest, isAdmin } from '@/lib/session-auth';

// PATCH /api/bugs/[id] — update a bug report (admin only)
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authenticateRequest(request);
  if (!auth.authenticated || !auth.identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdmin(auth.identity)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { status, adminNotes, duplicateOf } = body as {
    status?: string;
    adminNotes?: string;
    duplicateOf?: string;
  };

  const updates: Partial<typeof bugReports.$inferInsert> = {
    reviewedBy: auth.identity.did,
    reviewedAt: new Date(),
  };
  if (typeof status === 'string') updates.status = status;
  if (typeof adminNotes === 'string') updates.adminNotes = adminNotes;
  if (typeof duplicateOf === 'string') updates.duplicateOf = duplicateOf;

  const [updated] = await db
    .update(bugReports)
    .set(updates)
    .where(eq(bugReports.id, params.id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(updated);
}
