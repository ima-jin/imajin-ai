import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers, profiles } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const ALLOWED_ROLES = ['maintainer', 'admin', 'owner'];

interface RouteParams {
  params: Promise<{ did: string }>;
}

/**
 * PATCH /profile/api/stubs/:did
 * Update profile fields (avatar, banner) for a stub business identity.
 * Caller must be a maintainer, admin, or owner.
 *
 * Client flow: upload to /media/api/assets → get URL → call this endpoint
 * Accepts: { avatar?: string; banner?: string }
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { did } = await params;

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

  let body: { avatar?: string; banner?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { avatar, banner } = body;
  if (!avatar && !banner) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const patch: Partial<typeof profiles.$inferInsert> = {};
  if (avatar) patch.avatar = avatar;
  if (banner) patch.banner = banner;

  await db.update(profiles).set(patch).where(eq(profiles.did, did));

  log.info({ did, fields: Object.keys(patch) }, '[stubs] Profile fields updated');
  return NextResponse.json({ ok: true });
}
