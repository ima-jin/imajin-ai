import { NextRequest } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { eq, and } from 'drizzle-orm';
import { db, participants } from '@/db';
import { requireAuth } from '@/lib/auth';
import { errorResponse } from '@/lib/utils';

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

/**
 * POST /api/conversations/:id/upload - Upload media to conversation
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return errorResponse(authResult.error, authResult.status);
  }

  const { identity } = authResult;
  const { id: conversationId } = await params;

  try {
    // Check if user is a participant
    const participant = await db.query.participants.findFirst({
      where: and(
        eq(participants.conversationId, conversationId),
        eq(participants.did, identity.id)
      ),
    });

    if (!participant) {
      return errorResponse('Conversation not found or access denied', 404);
    }

    if (participant.role === 'readonly') {
      return errorResponse('You do not have permission to upload files', 403);
    }

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

    // Create conversation-specific upload directory
    const convUploadDir = path.join(UPLOAD_DIR, conversationId);
    if (!existsSync(convUploadDir)) {
      await mkdir(convUploadDir, { recursive: true });
    }

    const ext = file.name.split('.').pop() || 'bin';
    const timestamp = Date.now();
    const filename = `${timestamp}.${ext}`;
    const filepath = path.join(convUploadDir, filename);

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    let mediaMeta: any = {
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
    };

    let mediaType: 'image' | 'file';
    let thumbnailPath: string | null = null;

    if (isImage) {
      mediaType = 'image';

      // Get image dimensions
      const metadata = await sharp(buffer).metadata();
      mediaMeta.width = metadata.width;
      mediaMeta.height = metadata.height;

      // Resize image if needed (max 1600px)
      const maxDimension = 1600;
      let processedBuffer: Buffer = buffer;

      if (metadata.width && metadata.height) {
        if (metadata.width > maxDimension || metadata.height > maxDimension) {
          const resizedBuffer = await sharp(buffer)
            .resize(maxDimension, maxDimension, {
              fit: 'inside',
              withoutEnlargement: true,
            })
            .jpeg({ quality: 85 })
            .toBuffer();
          processedBuffer = resizedBuffer;
        }
      }

      // Save resized image
      await writeFile(filepath, processedBuffer);

      // Generate thumbnail (300px max)
      const thumbFilename = `${timestamp}_thumb.jpg`;
      const thumbPath = path.join(convUploadDir, thumbFilename);

      await sharp(buffer)
        .resize(300, 300, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer()
        .then(thumbBuffer => writeFile(thumbPath, thumbBuffer));

      thumbnailPath = `${conversationId}/${thumbFilename}`;
      mediaMeta.thumbnailPath = thumbnailPath;
    } else {
      mediaType = 'file';
      // Save file as-is
      await writeFile(filepath, buffer);
    }

    const mediaPath = `${conversationId}/${filename}`;

    return Response.json({
      mediaType,
      mediaPath,
      mediaMeta,
    }, { status: 200 });
  } catch (error) {
    console.error('Upload failed:', error);
    return errorResponse('Upload failed', 500);
  }
}
