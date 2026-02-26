import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const MEDIA_BASE = '/mnt/media';

// Map file extensions to content types
const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * GET /api/media/[...path] - Serve files from /mnt/media
 * Example: /api/media/avatars/user-123.jpg -> /mnt/media/avatars/user-123.jpg
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    // Reconstruct the file path
    const requestedPath = params.path.join('/');

    // Security: prevent directory traversal
    if (requestedPath.includes('..')) {
      return Response.json({ error: 'Invalid path' }, { status: 400 });
    }

    const filepath = path.join(MEDIA_BASE, requestedPath);

    // Check if file exists
    if (!existsSync(filepath)) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    // Read file
    const buffer = await readFile(filepath);

    // Determine content type from extension
    const ext = requestedPath.split('.').pop()?.toLowerCase() || '';
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

    // Return file with appropriate headers
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    console.error('Media serving failed:', error);
    return Response.json({ error: 'Failed to serve file' }, { status: 500 });
  }
}
