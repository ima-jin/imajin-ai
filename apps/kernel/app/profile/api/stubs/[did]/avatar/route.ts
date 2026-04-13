import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { db, identityMembers, profiles } from '@/src/db';
import { eq, and, isNull } from 'drizzle-orm';
import { requireAuth } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');
const UPLOAD_DIR = '/mnt/media/avatars';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_ROLES = ['maintainer', 'admin', 'owner'];

interface RouteParams {
  params: Promise<{ did: string }>;
}

/**
 * POST /profile/api/stubs/:did/avatar
 * Upload an avatar image for a stub business identity.
 * Caller must be a maintainer, admin, or owner of the identity.
 * Accepts: multipart/form-data with 'image' field
 * Returns: { url: string }
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

    // Clean up old avatars for this DID
    try {
      const { readdir, unlink } = await import('fs/promises');
      const files = await readdir(UPLOAD_DIR);
      const oldFiles = files.filter(f => f.startsWith(didShort) && f !== filename);
      await Promise.all(oldFiles.map(f => unlink(path.join(UPLOAD_DIR, f)).catch(() => {})));
    } catch {}

    const url = `/api/media/avatars/${filename}?v=${timestamp}`;

    // Update profile avatar
    await db
      .update(profiles)
      .set({ avatar: url })
      .where(eq(profiles.did, did));

    log.info({ did, url }, '[stubs/avatar] Avatar updated');
    return NextResponse.json({ url });
  } catch (error) {
    log.error({ err: String(error) }, '[stubs/avatar] Upload failed');
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
