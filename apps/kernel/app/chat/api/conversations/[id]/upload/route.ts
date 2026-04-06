import { NextRequest } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { requireAuth } from '@/src/lib/chat/auth';
import { errorResponse } from '@/src/lib/chat/utils';

const UPLOAD_DIR = '/mnt/media/chat';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const FILE_TYPES = [
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

async function verifyAccess(did: string, cookieHeader: string | null): Promise<boolean> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/access/${encodeURIComponent(did)}`, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * POST /api/conversations/:id/upload - Upload media to conversation
 * :id is a URL-encoded conversation DID.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { id } = await params;
  const conversationDid = decodeURIComponent(id);

  const hasAccess = await verifyAccess(conversationDid, request.headers.get('Cookie'));
  if (!hasAccess) {
    return errorResponse('Conversation not found or access denied', 404);
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return errorResponse('No file provided', 400);
    }

    if (file.size > MAX_FILE_SIZE) {
      return errorResponse('File too large. Maximum size is 25MB.', 400);
    }

    const isImage = IMAGE_TYPES.includes(file.type);
    const isFile = FILE_TYPES.includes(file.type);

    if (!isImage && !isFile) {
      return errorResponse('Invalid file type', 400);
    }

    // Use a filesystem-safe slug from the DID (replace colons with underscores)
    const dirSlug = conversationDid.replace(/[^a-zA-Z0-9_-]/g, '_');
    const convUploadDir = path.join(UPLOAD_DIR, dirSlug);
    if (!existsSync(convUploadDir)) {
      await mkdir(convUploadDir, { recursive: true });
    }

    const ext = file.name.split('.').pop() || 'bin';
    const timestamp = Date.now();
    const filename = `${timestamp}.${ext}`;
    const filepath = path.join(convUploadDir, filename);

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    let mediaMeta: Record<string, unknown> = {
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
    };

    let mediaType: 'image' | 'file';

    if (isImage) {
      mediaType = 'image';

      const metadata = await sharp(buffer).metadata();
      mediaMeta.width = metadata.width;
      mediaMeta.height = metadata.height;

      const maxDimension = 1600;
      let processedBuffer: Buffer = buffer;

      if (metadata.width && metadata.height) {
        if (metadata.width > maxDimension || metadata.height > maxDimension) {
          processedBuffer = await sharp(buffer)
            .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        }
      }

      await writeFile(filepath, processedBuffer);

      const thumbFilename = `${timestamp}_thumb.jpg`;
      const thumbPath = path.join(convUploadDir, thumbFilename);

      await sharp(buffer)
        .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
        .then(thumbBuffer => writeFile(thumbPath, thumbBuffer));

      mediaMeta.thumbnailPath = `${dirSlug}/${thumbFilename}`;
    } else {
      mediaType = 'file';
      await writeFile(filepath, buffer);
    }

    const mediaPath = `${dirSlug}/${filename}`;

    return Response.json({ mediaType, mediaPath, mediaMeta }, { status: 200 });
  } catch (error) {
    console.error('Upload failed:', error);
    return errorResponse('Upload failed', 500);
  }
}
