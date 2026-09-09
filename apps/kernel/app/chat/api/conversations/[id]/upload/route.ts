import { NextRequest } from 'next/server';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { errorResponse } from '@/src/lib/kernel/utils';
import { checkAccess } from '@/src/lib/kernel/access';
import { createLogger } from '@imajin/logger';
import { processImageUpload, validateUploadFile } from '@/src/lib/chat/upload';

const log = createLogger('kernel');

const UPLOAD_DIR = '/mnt/media/chat';

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

  const { identity } = authResult;
  const effectiveDid = resolveActingDid(identity);
  const access = await checkAccess(effectiveDid, conversationDid);
  if (!access.allowed) {
    return errorResponse('Conversation not found or access denied', 404);
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    const validation = validateUploadFile(file);
    if (!validation.ok) {
      return errorResponse(validation.error, validation.status);
    }
    const { isImage } = validation;
    const validFile = file as File;

    // Use a filesystem-safe slug from the DID (replace colons with underscores)
    const dirSlug = conversationDid.replace(/[^a-zA-Z0-9_-]/g, '_');
    const convUploadDir = path.join(UPLOAD_DIR, dirSlug);
    if (!existsSync(convUploadDir)) {
      await mkdir(convUploadDir, { recursive: true });
    }

    const ext = validFile.name.split('.').pop() || 'bin';
    const timestamp = Date.now();
    const filename = `${timestamp}.${ext}`;
    const filepath = path.join(convUploadDir, filename);

    const bytes = await validFile.arrayBuffer();
    const buffer = Buffer.from(bytes);

    let mediaMeta: Record<string, unknown> = {
      originalName: validFile.name,
      mimeType: validFile.type,
      size: validFile.size,
    };

    const mediaType: 'image' | 'file' = isImage ? 'image' : 'file';

    if (isImage) {
      ({ mediaMeta } = await processImageUpload({ buffer, filepath, convUploadDir, dirSlug, timestamp, mediaMeta }));
    } else {
      await writeFile(filepath, buffer);
    }

    const mediaPath = `${dirSlug}/${filename}`;

    return Response.json({ mediaType, mediaPath, mediaMeta }, { status: 200 });
  } catch (error) {
    log.error({ err: String(error) }, 'Upload failed');
    return errorResponse('Upload failed', 500);
  }
}
