import { optionalAuth } from '@imajin/auth';
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@imajin/config';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { withLogger, type Logger } from '@imajin/logger';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UrlBody = {
  kind: 'url';
  url: string;
  language?: string;
};

type FileBody = {
  kind: 'file';
  file: Blob;
  fileName: string;
  fileType: string;
  language?: string;
};

type ParsedBody = UrlBody | FileBody;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGpuHeaders(callerDid: string): Record<string, string> {
  const headers: Record<string, string> = { 'X-Caller-DID': callerDid };
  const token = process.env.GPU_AUTH_TOKEN;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function parseRequestBody(request: NextRequest): Promise<ParsedBody | null> {
  const contentType = request.headers.get('content-type') ?? '';
  const isJson = contentType.split(';')[0].trim() === 'application/json';

  if (isJson) {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.url !== 'string' || body.url.length === 0) {
      return null;
    }
    // SSRF guard: only allow https URLs
    let parsed: URL;
    try {
      parsed = new URL(body.url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'https:') {
      return null;
    }
    const language = typeof body.language === 'string' ? body.language : undefined;
    return { kind: 'url', url: body.url, language };
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || !(file instanceof Blob)) {
    return null;
  }
  const langField = formData.get('language');
  const language = typeof langField === 'string' ? langField : undefined;
  const fileName = file instanceof File ? file.name || 'audio.webm' : 'audio.webm';
  const fileType = file.type || 'audio/webm';
  return { kind: 'file', file, fileName, fileType, language };
}

async function handleGpuResponse(
  gpuRes: Response,
  cors: Record<string, string>,
  log: Logger,
): Promise<NextResponse> {
  if (!gpuRes.ok) {
    const errorText = await gpuRes.text();
    log.error({ status: gpuRes.status, errorText }, 'GPU node transcription failed');
    return NextResponse.json({ error: 'Transcription failed' }, { status: 502, headers: cors });
  }
  const result = await gpuRes.json();
  return NextResponse.json(result, { headers: cors });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function transcribeUrl(
  body: UrlBody,
  gpuNodeUrl: string,
  gpuHeaders: Record<string, string>,
  cors: Record<string, string>,
  log: Logger,
): Promise<NextResponse> {
  try {
    const gpuRes = await fetch(`${gpuNodeUrl}/api/stream2text/transcribe`, {
      method: 'POST',
      headers: { ...gpuHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: body.url, language: body.language }),
    });
    return handleGpuResponse(gpuRes, cors, log);
  } catch (error) {
    log.error({ err: String(error) }, 'GPU node unreachable');
    return NextResponse.json(
      { error: 'Transcription service unavailable' },
      { status: 503, headers: cors },
    );
  }
}

async function transcribeFile(
  body: FileBody,
  gpuNodeUrl: string,
  gpuHeaders: Record<string, string>,
  cors: Record<string, string>,
  log: Logger,
): Promise<NextResponse> {
  const fileBytes = Buffer.from(await body.file.arrayBuffer());
  const tmpPath = join(tmpdir(), `transcribe-${randomBytes(8).toString('hex')}-${body.fileName}`);

  try {
    await writeFile(tmpPath, fileBytes);

    const gpuForm = new FormData();
    gpuForm.append('file', new File([fileBytes], body.fileName, { type: body.fileType }));
    if (body.language) {
      gpuForm.append('language', body.language);
    }

    const gpuRes = await fetch(`${gpuNodeUrl}/api/whisper/transcribe`, {
      method: 'POST',
      body: gpuForm,
      headers: gpuHeaders,
    });
    return handleGpuResponse(gpuRes, cors, log);
  } catch (error) {
    log.error({ err: String(error) }, 'GPU node unreachable');
    return NextResponse.json(
      { error: 'Transcription service unavailable' },
      { status: 503, headers: cors },
    );
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * POST /api/transcribe
 *
 * Accepts audio file (multipart), validates session (optional — anonymous allowed),
 * relays to GPU Whisper node for transcription. Returns transcript text + segments.
 *
 * Also accepts JSON { url, language? } to transcribe from a URL via the GPU
 * node's stream2text pipeline (yt-dlp → Whisper).
 *
 * Moved from apps/input — the media service is now the public-facing endpoint
 * for both file storage and transcription.
 */
export const POST = withLogger('kernel', async (request, { log }) => {
  const cors = corsHeaders(request);
  const gpuNodeUrl = process.env.GPU_NODE_URL;
  if (!gpuNodeUrl) {
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

  const identity = await optionalAuth(request);
  const callerDid = identity?.id || 'anonymous';

  const body = await parseRequestBody(request);
  if (!body) {
    return NextResponse.json(
      { error: 'Provide a multipart file or JSON { url } (https only)' },
      { status: 400, headers: cors }
    );
  }

  const gpuHeaders = buildGpuHeaders(callerDid);

  if (body.kind === 'url') {
    return transcribeUrl(body, gpuNodeUrl, gpuHeaders, cors, log);
  }
  return transcribeFile(body, gpuNodeUrl, gpuHeaders, cors, log);
});
