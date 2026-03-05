import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // TODO: implement file upload job creation
  // 1. Parse multipart form data
  // 2. Validate file type and size
  // 3. Forward to media service for storage
  // 4. Create job record in db
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 });
}
