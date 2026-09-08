import { NextRequest, NextResponse } from 'next/server';
import { db, identities, profiles } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { buildProfilePatch, checkStubMaintainerAccess } from '@/src/lib/profile/stubs';

const log = createLogger('kernel');

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
  const hasAccess = await checkStubMaintainerAccess(did, caller.id);
  if (!hasAccess) {
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

  const profilePatch = await buildProfilePatch(did, { avatar, banner, name, bio, category, location, lat, lon });
  if (!profilePatch) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
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
