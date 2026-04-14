import { NextRequest, NextResponse } from 'next/server';
import { db, identityMembers, profileImages } from '@/src/db';
import { eq, and, isNull, count } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const ALLOWED_ROLES = ['maintainer', 'admin', 'owner'];
const MAX_GALLERY_IMAGES = 6;

interface RouteParams {
  params: Promise<{ did: string }>;
}

/**
 * GET /profile/api/stubs/:did/images
 * List gallery images for a stub, ordered by sortOrder.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { did } = await params;

  const images = await db
    .select()
    .from(profileImages)
    .where(eq(profileImages.did, did))
    .orderBy(profileImages.sortOrder);

  return NextResponse.json({ images });
}

/**
 * POST /profile/api/stubs/:did/images
 * Add a gallery image URL (already uploaded to /media/api/assets).
 * Caller must be a maintainer, admin, or owner of the identity.
 *
 * Client flow: upload to /media/api/assets → get URL → call this endpoint
 * Accepts: { url: string; caption?: string }
 * Returns: { image: ProfileImage }
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
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

  // Check gallery image count
  const [{ total }] = await db
    .select({ total: count() })
    .from(profileImages)
    .where(eq(profileImages.did, did));

  if (total >= MAX_GALLERY_IMAGES) {
    return NextResponse.json(
      { error: `Maximum of ${MAX_GALLERY_IMAGES} gallery images allowed.` },
      { status: 400 }
    );
  }

  let body: { url: string; caption?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { url, caption } = body;
  if (!url || typeof url !== 'string') {
    return NextResponse.json({ error: 'url is required' }, { status: 400 });
  }

  const id = `img_${Math.random().toString(36).slice(2, 18)}`;

  const [image] = await db
    .insert(profileImages)
    .values({
      id,
      did,
      url,
      caption: caption ?? null,
      sortOrder: total,
      createdBy: caller.id,
    })
    .returning();

  log.info({ did, id }, '[stubs/images] Gallery image added');
  return NextResponse.json({ image });
}
