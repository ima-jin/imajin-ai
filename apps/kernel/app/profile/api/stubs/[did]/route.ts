import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers, profiles, identities } from '@/src/db';
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
 * Update profile fields for a stub business identity.
 * Caller must be a maintainer, admin, or owner.
 *
 * Client flow: upload to /media/api/assets → get URL → call this endpoint
 * Accepts: {
 *   avatar?: string; banner?: string;
 *   name?: string; bio?: string;
 *   category?: string; location?: string; lat?: number; lon?: number;
 * }
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

  let body: {
    avatar?: string;
    banner?: string;
    name?: string;
    bio?: string;
    category?: string;
    location?: string;
    lat?: number;
    lon?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { avatar, banner, name, bio, category, location, lat, lon } = body;

  const hasUpdate = avatar || banner || name !== undefined || bio !== undefined
    || category !== undefined || location !== undefined || lat !== undefined || lon !== undefined;
  if (!hasUpdate) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const profilePatch: Partial<typeof profiles.$inferInsert> = {};
  if (avatar) profilePatch.avatar = avatar;
  if (banner) profilePatch.banner = banner;
  if (name !== undefined) profilePatch.displayName = name;
  if (bio !== undefined) profilePatch.bio = bio;

  // Merge metadata fields (category, location, lat, lon) with existing metadata
  if (category !== undefined || location !== undefined || lat !== undefined || lon !== undefined) {
    const [existing] = await db
      .select({ metadata: profiles.metadata })
      .from(profiles)
      .where(eq(profiles.did, did))
      .limit(1);

    const currentMeta = (existing?.metadata as Record<string, unknown>) ?? {};
    const newMeta = { ...currentMeta };
    if (category !== undefined) newMeta.category = category;
    if (location !== undefined) newMeta.location = location;
    if (lat !== undefined) newMeta.lat = lat;
    if (lon !== undefined) newMeta.lon = lon;
    profilePatch.metadata = newMeta;
  }

  if (Object.keys(profilePatch).length > 0) {
    await db.update(profiles).set(profilePatch).where(eq(profiles.did, did));
  }

  // Sync display name into auth.identities as well
  if (name !== undefined) {
    await db.update(identities).set({ name }).where(eq(identities.id, did));
  }

  log.info({ did, fields: Object.keys(body) }, '[stubs] Profile fields updated');
  return NextResponse.json({ ok: true });
}
