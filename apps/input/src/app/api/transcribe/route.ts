import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // TODO: implement transcription job creation
  // 1. Parse multipart form data
  // 2. Store audio file via media service
  // 3. Create job record in db
  // 4. Enqueue transcription task
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 });
}
