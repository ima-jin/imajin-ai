import { optionalAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/metering';
import { corsHeaders, corsOptions } from '@/lib/cors';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const GPU_NODE_URL = process.env.GPU_NODE_URL || 'http://192.168.1.124:8765';
const GPU_AUTH_TOKEN = process.env.GPU_AUTH_TOKEN || '';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/transcribe
 *
 * Accepts audio file (multipart), validates session, relays to GPU node for
 * Whisper transcription. Returns transcript text + segments.
 *
 * The input service is the public-facing endpoint; the GPU node is internal only.
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  // Validate session (optional — allow anonymous for now, but track DID if present)
  const identity = await optionalAuth(request);
  const callerDid = identity?.id || 'anonymous';

  // Rate limit check
  const rateCheck = checkRateLimit(callerDid, 'transcribe');
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs },
      { status: 429, headers: { ...cors, 'Retry-After': String(Math.ceil(rateCheck.retryAfterMs / 1000)) } }
    );
  }

  // Get the audio file from the request
  const formData = await request.formData();
  const file = formData.get('file');

  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'Audio file is required (multipart field "file")' },
      { status: 400, headers: cors }
    );
  }

  // Relay to GPU node — write to temp file then use undici for reliable multipart upload
  const fileBytes = Buffer.from(await file.arrayBuffer());
  const fileName = (file as File).name || 'audio.webm';
  const fileType = file.type || 'audio/webm';
  const tmpPath = join(tmpdir(), `input-${randomBytes(8).toString('hex')}-${fileName}`);

  // Pass through optional language param
  const language = formData.get('language');

  try {
    await writeFile(tmpPath, fileBytes);

    // Use native FormData with File object
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
        { status: 502 }
      );
    }

    const result = await gpuRes.json();

    // TODO: Log to jobs table for metering (#172)

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
