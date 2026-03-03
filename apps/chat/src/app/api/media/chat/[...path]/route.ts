import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const MEDIA_DIR = '/mnt/media/chat';

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * GET /api/media/chat/[...path] - Serve media files
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: pathSegments } = await params;

    if (!pathSegments || pathSegments.length === 0) {
      return new Response('Not found', { status: 404 });
    }

    // Join path segments and resolve to absolute path
    const requestedPath = pathSegments.join('/');
    const filepath = path.join(MEDIA_DIR, requestedPath);

    // Security: ensure the resolved path is within MEDIA_DIR
    const normalizedPath = path.normalize(filepath);
    if (!normalizedPath.startsWith(MEDIA_DIR)) {
      return new Response('Forbidden', { status: 403 });
    }

    if (!existsSync(filepath)) {
      return new Response('Not found', { status: 404 });
    }

    const buffer = await readFile(filepath);
    const ext = path.extname(filepath).slice(1).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    console.error('Media serving failed:', error);
    return new Response('Internal server error', { status: 500 });
  }
}
