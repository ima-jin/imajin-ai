import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { verifyAppToken } from '@/src/lib/auth/jwt';

/** Re-read registration and operator approval on every call, not only token mint. */
export async function authenticatePayApp(
  request: NextRequest,
  scope: string,
): Promise<{ appDid: string } | { error: string; status: number }> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return { error: 'Unauthorized - app-service token required', status: 401 };
  }
  const claims = await verifyAppToken(header.slice('Bearer '.length));
  if (!claims) {
    return { error: 'Unauthorized - invalid or expired app-service token', status: 401 };
  }
  if (!claims.isServiceToken || !claims.azp) {
    return { error: 'Forbidden - an app-service token is required', status: 403 };
  }
  if (!claims.scope.split(' ').filter(Boolean).includes(scope)) {
    return { error: `Forbidden - scope '${scope}' was not granted`, status: 403 };
  }
  const [app] = await db
    .select({ status: registryApps.status, approved: registryApps.approvedServiceScopes })
    .from(registryApps)
    .where(eq(registryApps.appDid, claims.azp))
    .limit(1);
  if (app?.status !== 'active') {
    return { error: 'Forbidden - app is not an active registered app', status: 403 };
  }
  if (!Array.isArray(app.approved) || !app.approved.includes(scope)) {
    return { error: `Forbidden - '${scope}' is not operator-approved for this app`, status: 403 };
  }
  return { appDid: claims.azp };
}
