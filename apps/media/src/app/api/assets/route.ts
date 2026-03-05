import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db } from '@/db';
import { assets } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const ownerAssets = await db
    .select()
    .from(assets)
    .where(eq(assets.ownerDid, auth.identity.id));

  return NextResponse.json({ assets: ownerAssets });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // TODO: implement asset creation
  // 1. Parse multipart form data
  // 2. Store file at DID-based path
  // 3. Generate thumbnail if applicable
  // 4. Insert asset record
  return NextResponse.json({ error: 'Not implemented' }, { status: 501 });
}
