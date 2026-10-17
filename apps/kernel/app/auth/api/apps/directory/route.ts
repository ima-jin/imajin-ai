import { NextRequest, NextResponse } from 'next/server';
import { resolveAppDirectoryForIdentity } from '@/src/lib/kernel/app-nav';
import { authenticateAppDirectory } from '@/src/lib/kernel/app-directory-request';

export async function GET(request: NextRequest) {
  const auth = await authenticateAppDirectory(request);
  if ('error' in auth) return auth.error;
  const apps = await resolveAppDirectoryForIdentity(auth.did);
  return NextResponse.json({ apps }, { headers: { 'Cache-Control': 'private, no-store' } });
}
