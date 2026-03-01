import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const MEDIA_BASE = '/mnt/media';

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    const requestedPath = params.path.join('/');

    if (requestedPath.includes('..')) {
      return Response.json({ error: 'Invalid path' }, { status: 400 });
    }

    const filepath = path.join(MEDIA_BASE, requestedPath);

    if (!existsSync(filepath)) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    const buffer = await readFile(filepath);
    const ext = requestedPath.split('.').pop()?.toLowerCase() || '';
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('Media serving failed:', error);
    return Response.json({ error: 'Failed to serve file' }, { status: 500 });
  }
}
