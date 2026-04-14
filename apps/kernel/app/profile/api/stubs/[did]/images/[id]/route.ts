import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers, profileImages } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const ALLOWED_ROLES = ['maintainer', 'admin', 'owner'];

interface RouteParams {
  params: Promise<{ did: string; id: string }>;
}

/**
 * DELETE /profile/api/stubs/:did/images/:id
 * Remove a gallery image record. Caller must be a maintainer, admin, or owner.
 * File cleanup is handled by the media service — this only removes the DB row.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { did, id } = await params;

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity: caller } = authResult;

  // Check caller is maintainer/admin/owner of this identity
  const [membership] = await db
    .select({ role: identityMembers.role })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, did),
        eq(identityMembers.memberDid, caller.id),
        isNull(identityMembers.removedAt)
      )
    )
    .limit(1);

  if (!membership || !ALLOWED_ROLES.includes(membership.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Find and delete the image record
  const [image] = await db
    .select()
    .from(profileImages)
    .where(and(eq(profileImages.id, id), eq(profileImages.did, did)))
    .limit(1);

  if (!image) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await db.delete(profileImages).where(eq(profileImages.id, id));

  log.info({ did, id }, '[stubs/images] Gallery image deleted');
  return NextResponse.json({ ok: true });
}
