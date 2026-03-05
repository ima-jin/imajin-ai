import { NextRequest, NextResponse } from 'next/server';

const GPU_NODE_URL = process.env.GPU_NODE_URL || 'http://192.168.1.124:8765';
const GPU_AUTH_TOKEN = process.env.GPU_AUTH_TOKEN || '';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:7001';

/**
 * POST /api/transcribe
 * 
 * Accepts audio file (multipart), validates session, relays to GPU node for
 * Whisper transcription. Returns transcript text + segments.
 * 
 * The input service is the public-facing endpoint; the GPU node is internal only.
 */
export async function POST(request: NextRequest) {
  // Validate session (optional — allow anonymous for now, but track DID if present)
  let callerDid = 'anonymous';
  try {
    const sessionCookie = request.cookies.get('imajin_session')?.value;
    if (sessionCookie) {
      const sessionRes = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
        headers: { Cookie: `imajin_session=${sessionCookie}` },
      });
      if (sessionRes.ok) {
        const session = await sessionRes.json();
        callerDid = session.did || session.sub || 'anonymous';
      }
    }
  } catch {
    // Auth failure is non-fatal — proceed as anonymous
  }

  // Get the audio file from the request
  const formData = await request.formData();
  const file = formData.get('file');

  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'Audio file is required (multipart field "file")' },
      { status: 400 }
    );
  }

  // Relay to GPU node
  const gpuFormData = new FormData();
  gpuFormData.append('file', file);

  // Pass through optional language param
  const language = formData.get('language');
  if (language && typeof language === 'string') {
    gpuFormData.append('language', language);
  }

  try {
    const gpuRes = await fetch(`${GPU_NODE_URL}/api/whisper/transcribe`, {
      method: 'POST',
      body: gpuFormData,
      headers: {
        ...(GPU_AUTH_TOKEN ? { Authorization: `Bearer ${GPU_AUTH_TOKEN}` } : {}),
        'X-Caller-DID': callerDid,
      },
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

    return NextResponse.json(result);
  } catch (error) {
    console.error('GPU node unreachable:', error);
    return NextResponse.json(
      { error: 'Transcription service unavailable' },
      { status: 503 }
    );
  }
}
