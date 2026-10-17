import type { NextRequest } from 'next/server';
import { requireAdmin } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { resolveAppServiceCaller } from '@/src/lib/auth/app-service-caller';

export const TEMPLATE_READ_SCOPE = 'registry:template-read';

/** Automation reads include private apps: possession of just any app key is not enough. */
export async function authorizeTemplateReader(request: NextRequest): Promise<401 | 403 | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return await requireAdmin() ? null : 401;
  const caller = await resolveAppServiceCaller(header.slice('Bearer '.length));
  if (!caller) return 401;
  if (!caller.scopes.includes(TEMPLATE_READ_SCOPE)) return 403;
  const [app] = await db
    .select({ approved: registryApps.approvedServiceScopes, status: registryApps.status })
    .from(registryApps)
    .where(eq(registryApps.appDid, caller.appDid))
    .limit(1);
  return app?.status === 'active' && app.approved.includes(TEMPLATE_READ_SCOPE) ? null : 403;
}
