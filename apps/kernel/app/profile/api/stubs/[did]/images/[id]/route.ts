import { NextRequest, NextResponse } from 'next/server';
import { unlink } from 'fs/promises';
import path from 'path';
import { db, identityMembers, profileImages } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const UPLOAD_DIR = '/mnt/media/gallery';
const ALLOWED_ROLES = ['maintainer', 'admin', 'owner'];

interface RouteParams {
  params: Promise<{ did: string; id: string }>;
}

/**
 * DELETE /profile/api/stubs/:did/images/:id
 * Remove a gallery image. Caller must be a maintainer, admin, or owner.
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

  // Find the image
  const [image] = await db
    .select()
    .from(profileImages)
    .where(and(eq(profileImages.id, id), eq(profileImages.did, did)))
    .limit(1);

  if (!image) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Delete the file
  try {
    const filename = image.url.split('/').pop()?.split('?')[0];
    if (filename) {
      await unlink(path.join(UPLOAD_DIR, filename)).catch(() => {});
    }
  } catch {}

  // Delete the row
  await db.delete(profileImages).where(eq(profileImages.id, id));

  log.info({ did, id }, '[stubs/images] Gallery image deleted');
  return NextResponse.json({ ok: true });
}
