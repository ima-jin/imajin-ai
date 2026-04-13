import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { db, identityMembers, profileImages } from '@/src/db';
import { eq, and, isNull, count } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const UPLOAD_DIR = '/mnt/media/gallery';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
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
 * Upload a new gallery image (max 6 per stub).
 * Caller must be a maintainer, admin, or owner of the identity.
 * Accepts: multipart/form-data with 'image' field and optional 'caption'
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

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const file = formData.get('image') as File | null;
  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: 'Invalid file type. Only JPG, PNG, GIF, and WebP are allowed.' },
      { status: 400 }
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File too large. Maximum size is 5MB.' }, { status: 400 });
  }

  const caption = (formData.get('caption') as string | null) || null;

  try {
    if (!existsSync(UPLOAD_DIR)) {
      await mkdir(UPLOAD_DIR, { recursive: true });
    }

    const ext = file.name.split('.').pop() || 'jpg';
    const timestamp = Date.now();
    const didShort = did.replace('did:imajin:', '').slice(0, 16);
    const filename = `${didShort}-${timestamp}.${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    await writeFile(filepath, buffer);

    const url = `/api/media/gallery/${filename}?v=${timestamp}`;
    const id = `img_${Math.random().toString(36).slice(2, 18)}`;

    const [image] = await db
      .insert(profileImages)
      .values({
        id,
        did,
        url,
        caption,
        sortOrder: total,
        createdBy: caller.id,
      })
      .returning();

    log.info({ did, id }, '[stubs/images] Gallery image added');
    return NextResponse.json({ image });
  } catch (error) {
    log.error({ err: String(error) }, '[stubs/images] Upload failed');
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
