import { optionalAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@/src/lib/kernel/rate-limit';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const GPU_NODE_URL = process.env.GPU_NODE_URL || 'http://192.168.1.124:8765';
const GPU_AUTH_TOKEN = process.env.GPU_AUTH_TOKEN || '';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/transcribe
 *
 * Accepts audio file (multipart), validates session (optional — anonymous allowed),
 * relays to GPU Whisper node for transcription. Returns transcript text + segments.
 *
 * Moved from apps/input — the media service is now the public-facing endpoint
 * for both file storage and transcription.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 30, 60 * 60 * 1000); // 30 per hour per IP
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } }
    );
  }

  // Optional auth — allow anonymous but track DID if present
  const identity = await optionalAuth(request);
  const callerDid = identity?.id || 'anonymous';

  const formData = await request.formData();
  const file = formData.get('file');

  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'Audio file is required (multipart field "file")' },
      { status: 400, headers: cors }
    );
  }

  const fileBytes = Buffer.from(await file.arrayBuffer());
  const fileName = (file as File).name || 'audio.webm';
  const fileType = file.type || 'audio/webm';
  const tmpPath = join(tmpdir(), `transcribe-${randomBytes(8).toString('hex')}-${fileName}`);

  const language = formData.get('language');

  try {
    await writeFile(tmpPath, fileBytes);

    const gpuForm = new FormData();
    gpuForm.append('file', new File([fileBytes], fileName, { type: fileType }));
    if (language && typeof language === 'string') {
      gpuForm.append('language', language);
    }

    const gpuHeaders: Record<string, string> = {
      'X-Caller-DID': callerDid,
    };
    if (GPU_AUTH_TOKEN) {
      gpuHeaders['Authorization'] = `Bearer ${GPU_AUTH_TOKEN}`;
    }

    const gpuRes = await fetch(`${GPU_NODE_URL}/api/whisper/transcribe`, {
      method: 'POST',
      body: gpuForm,
      headers: gpuHeaders,
    });

    if (!gpuRes.ok) {
      const errorText = await gpuRes.text();
      console.error('GPU node transcription failed:', gpuRes.status, errorText);
      return NextResponse.json(
        { error: 'Transcription failed' },
        { status: 502, headers: cors }
      );
    }

    const result = await gpuRes.json();

    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    console.error('GPU node unreachable:', error);
    return NextResponse.json(
      { error: 'Transcription service unavailable' },
      { status: 503, headers: cors }
    );
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
