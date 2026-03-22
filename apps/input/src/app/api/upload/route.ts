import { requireAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/metering';
import { corsHeaders, corsOptions } from '@/lib/cors';

const MEDIA_SERVICE_URL = process.env.MEDIA_SERVICE_URL || 'http://localhost:7009';

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
  const file = formData.get('file');

  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'File is required (multipart field "file")' },
      { status: 400 }
    );
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
    });

    if (!mediaRes.ok) {
      const errorText = await mediaRes.text();
      console.error('Media service upload failed:', mediaRes.status, errorText);
      return NextResponse.json(
        { error: 'Upload failed' },
        { status: 502 }
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
