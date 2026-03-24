import { requireAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/metering';
import { corsHeaders, corsOptions } from '@/lib/cors';

const MEDIA_SERVICE_URL = process.env.MEDIA_SERVICE_URL || 'http://localhost:7009';

const GENERIC_AUDIO_PATTERN = /^(voice|blob|audio|recording|sound)\./i;

function generateAudioFilename(originalName: string, timestamp: Date): string {
  const ext = originalName.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = timestamp.getFullYear();
  const mo = pad(timestamp.getMonth() + 1);
  const d = pad(timestamp.getDate());
  const h = pad(timestamp.getHours());
  const mi = pad(timestamp.getMinutes());
  const s = pad(timestamp.getSeconds());
  return `Audio_${y}_${mo}_${d}_${h}_${mi}_${s}${ext}`;
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/upload
 *
 * Accepts file (multipart), validates session, forwards to media service
 * for storage + .fair attribution. Returns asset reference.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status, headers: cors }
    );
  }
  const callerDid = authResult.identity.id;

  // Rate limit check
  const rateCheck = checkRateLimit(callerDid, 'upload');
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rateCheck.retryAfterMs / 1000)) } }
    );
  }

  // Get the file from the request
  const formData = await request.formData();
  let file = formData.get('file');

  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'File is required (multipart field "file")' },
      { status: 400 }
    );
  }

  // Rename generic audio filenames to a timestamped name
  const originalFilename = (file instanceof File) ? file.name : 'upload';
  if (file.type.startsWith('audio/') && GENERIC_AUDIO_PATTERN.test(originalFilename)) {
    const newFilename = generateAudioFilename(originalFilename, new Date());
    // Forward as a named File so the media service picks up the new name
    const renamed = new File([file], newFilename, { type: file.type });
    file = renamed;
  }

  // Forward to media service
  const mediaFormData = new FormData();
  mediaFormData.append('file', file);
  mediaFormData.append('ownerDid', callerDid);

  // Pass through optional .fair terms
  const terms = formData.get('terms');
  if (terms && typeof terms === 'string') {
    mediaFormData.append('terms', terms);
  }

  // Pass through optional context for auto-folder assignment
  const context = formData.get('context');
  if (context && typeof context === 'string') {
    mediaFormData.append('context', context);
  }

  try {
    const mediaRes = await fetch(`${MEDIA_SERVICE_URL}/api/assets`, {
      method: 'POST',
      body: mediaFormData,
      headers: {
        Cookie: request.headers.get('Cookie') || '',
        'X-Caller-DID': callerDid,
      },
    });

    if (!mediaRes.ok) {
      const errorText = await mediaRes.text();
      console.error('Media service upload failed:', mediaRes.status, errorText);
      return NextResponse.json(
        { error: 'Upload failed' },
        { status: 502, headers: cors }
      );
    }

    const result = await mediaRes.json();

    // TODO: Log to jobs table for metering (#172)

    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    console.error('Media service unreachable:', error);
    return NextResponse.json(
      { error: 'Upload service unavailable' },
      { status: 503, headers: cors }
    );
  }
}
