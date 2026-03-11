import { SESSION_COOKIE_NAME } from "@imajin/config";
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/metering';
import { corsHeaders, corsOptions } from '@/lib/cors';

const MEDIA_SERVICE_URL = process.env.MEDIA_SERVICE_URL || 'http://localhost:7009';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:7001';

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
  // Validate session — uploads require authentication
  let callerDid: string | null = null;
  let sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (sessionCookie) {
    try {
      const sessionRes = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
      });
      if (sessionRes.ok) {
        const session = await sessionRes.json();
        callerDid = session.did || session.sub || null;
      }
    } catch {
      // Auth failure
    }
  }

  if (!callerDid) {
    return NextResponse.json(
      { error: 'Authentication required for file uploads' },
      { status: 401, headers: cors }
    );
  }

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

  try {
    const mediaRes = await fetch(`${MEDIA_SERVICE_URL}/api/assets`, {
      method: 'POST',
      body: mediaFormData,
      headers: sessionCookie ? { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` } : {},
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
