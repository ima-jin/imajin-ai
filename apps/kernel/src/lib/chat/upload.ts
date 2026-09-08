import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const FILE_TYPES = new Set([
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export type UploadFileValidation =
  | { ok: true; isImage: boolean }
  | { ok: false; error: string; status: number };

/** Validate an uploaded conversation file's presence, size, and MIME type. */
export function validateUploadFile(file: File | null): UploadFileValidation {
  if (!file) {
    return { ok: false, error: 'No file provided', status: 400 };
  }
  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, error: 'File too large. Maximum size is 25MB.', status: 400 };
  }

  const isImage = IMAGE_TYPES.has(file.type);
  const isFile = FILE_TYPES.has(file.type);
  if (!isImage && !isFile) {
    return { ok: false, error: 'Invalid file type', status: 400 };
  }

  return { ok: true, isImage };
}

export interface ProcessedImage {
  mediaMeta: Record<string, unknown>;
}

const MAX_IMAGE_DIMENSION = 1600;

/**
 * Process and persist an uploaded image: writes the (optionally downscaled)
 * full-size image and a thumbnail, and returns the media metadata to merge
 * into the response.
 */
export async function processImageUpload(params: {
  buffer: Buffer;
  filepath: string;
  convUploadDir: string;
  dirSlug: string;
  timestamp: number;
  mediaMeta: Record<string, unknown>;
}): Promise<ProcessedImage> {
  const { buffer, filepath, convUploadDir, dirSlug, timestamp, mediaMeta } = params;

  const metadata = await sharp(buffer).metadata();
  mediaMeta.width = metadata.width;
  mediaMeta.height = metadata.height;

  const needsResize = !!metadata.width && !!metadata.height
    && (metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION);
  const processedBuffer = needsResize
    ? await sharp(buffer)
        .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
    : buffer;

  await writeFile(filepath, processedBuffer);

  const thumbFilename = `${timestamp}_thumb.jpg`;
  const thumbPath = path.join(convUploadDir, thumbFilename);
  const thumbBuffer = await sharp(buffer)
    .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  await writeFile(thumbPath, thumbBuffer);

  mediaMeta.thumbnailPath = `${dirSlug}/${thumbFilename}`;
  return { mediaMeta };
}
