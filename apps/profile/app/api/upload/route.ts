import { NextRequest } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { errorResponse } from '@/lib/utils';

const UPLOAD_DIR = '/mnt/media/avatars';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * POST /api/upload - Upload an avatar image
 * Accepts: multipart/form-data with 'image' field and 'did' field
 * Returns: { url: string }
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('image') as File | null;
    const did = formData.get('did') as string | null;

    if (!file) {
      return errorResponse('No file provided');
    }

    if (!did) {
      return errorResponse('DID is required');
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      return errorResponse('Invalid file type. Only JPG, PNG, GIF, and WebP are allowed.');
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return errorResponse('File too large. Maximum size is 5MB.');
    }

    // Ensure upload directory exists
    if (!existsSync(UPLOAD_DIR)) {
      await mkdir(UPLOAD_DIR, { recursive: true });
    }

    // Generate unique filename: {did}-{timestamp}.{ext}
    const ext = file.name.split('.').pop() || 'jpg';
    const timestamp = Date.now();
    const didShort = did.replace('did:imajin:', '').slice(0, 16);
    const filename = `${didShort}-${timestamp}.${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);

    // Convert file to buffer and save
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    await writeFile(filepath, buffer);

    // Return public URL
    const url = `/api/media/avatars/${filename}`;

    return Response.json({ url }, { status: 200 });
  } catch (error) {
    console.error('Upload failed:', error);
    return errorResponse('Upload failed', 500);
  }
}
