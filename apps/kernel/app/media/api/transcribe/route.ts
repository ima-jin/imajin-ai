import { optionalAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@imajin/config';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { withLogger } from '@imajin/logger';

const GPU_NODE_URL = process.env.GPU_NODE_URL;
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
export const POST = withLogger('kernel', async (request, { log }) => {
  const cors = corsHeaders(request);
  if (!GPU_NODE_URL) {
    log.error({}, 'GPU_NODE_URL is not configured');
    return NextResponse.json(
      { error: 'Transcription service unavailable' },
      { status: 503, headers: cors }
    );
  }

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

  const contentType = request.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  let url: string | undefined;
  let language: string | undefined;
  let file: FormDataEntryValue | null = null;
  let fileName = 'audio.webm';
  let fileType = 'audio/webm';
  let fileBytes: Buffer | undefined;

  if (isJson) {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.url === 'string' && body.url.length > 0) {
      url = body.url;
    }
    if (typeof body.language === 'string') {
      language = body.language;
    }
  } else {
    const formData = await request.formData();
    file = formData.get('file');
    const langField = formData.get('language');
    if (langField && typeof langField === 'string') {
      language = langField;
    }
  }

  if (!url && (!file || !(file instanceof Blob))) {
    return NextResponse.json(
      { error: 'Provide a multipart file or JSON { url }' },
      { status: 400, headers: cors }
    );
  }

  const gpuHeaders: Record<string, string> = {
    'X-Caller-DID': callerDid,
  };
  if (GPU_AUTH_TOKEN) {
    gpuHeaders['Authorization'] = `Bearer ${GPU_AUTH_TOKEN}`;
  }

  if (url) {
    const gpuRes = await fetch(`${GPU_NODE_URL}/api/stream2text/transcribe`, {
      method: 'POST',
      headers: { ...gpuHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, language }),
    });

    if (!gpuRes.ok) {
      const errorText = await gpuRes.text();
      log.error({ status: gpuRes.status, errorText }, 'GPU node transcription failed');
      return NextResponse.json(
        { error: 'Transcription failed' },
        { status: 502, headers: cors }
      );
    }

    const result = await gpuRes.json();
    return NextResponse.json(result, { headers: cors });
  }

  // File branch
  fileBytes = Buffer.from(await (file as Blob).arrayBuffer());
  fileName = (file as File).name || 'audio.webm';
  fileType = (file as Blob).type || 'audio/webm';
  const tmpPath = join(tmpdir(), `transcribe-${randomBytes(8).toString('hex')}-${fileName}`);

  try {
    await writeFile(tmpPath, fileBytes);

    const gpuForm = new FormData();
    gpuForm.append('file', new File([fileBytes as unknown as BlobPart], fileName, { type: fileType }));
    if (language) {
      gpuForm.append('language', language);
    }

    const gpuRes = await fetch(`${GPU_NODE_URL}/api/whisper/transcribe`, {
      method: 'POST',
      body: gpuForm,
      headers: gpuHeaders,
    });

    if (!gpuRes.ok) {
      const errorText = await gpuRes.text();
      log.error({ status: gpuRes.status, errorText }, 'GPU node transcription failed');
      return NextResponse.json(
        { error: 'Transcription failed' },
        { status: 502, headers: cors }
      );
    }

    const result = await gpuRes.json();
    return NextResponse.json(result, { headers: cors });
  } catch (error) {
    log.error({ err: String(error) }, 'GPU node unreachable');
    return NextResponse.json(
      { error: 'Transcription service unavailable' },
      { status: 503, headers: cors }
    );
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
});
