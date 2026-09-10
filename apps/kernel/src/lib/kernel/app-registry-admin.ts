/**
 * Shared helpers for the admin app-registry mutation routes (#1990):
 * `POST /api/admin/registry/apps/:appId/rotate` and `.../revoke`. Both need
 * the same admin-session gate and the same "look up this app or 404" step;
 * extracted here so the two routes don't hand-copy identical boilerplate.
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { requireAdmin } from '@imajin/auth';

export interface AdminSession {
  actingAs: string;
}

/** `requireAdmin()`, normalized to a discriminated result an admin route can early-return on. */
export async function requireAdminSession(): Promise<{ session: AdminSession } | { error: NextResponse }> {
  const session = await requireAdmin();
  if (!session?.actingAs) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { session: { actingAs: session.actingAs } };
}

export interface RegistryAppLookup {
  id: string;
  appDid: string;
  status: string;
}

/** Look up one registry.apps row by id, or `null` when it does not exist. */
export async function findRegistryApp(appId: string): Promise<RegistryAppLookup | null> {
  const [row] = await db
    .select({ id: registryApps.id, appDid: registryApps.appDid, status: registryApps.status })
    .from(registryApps)
    .where(eq(registryApps.id, appId))
    .limit(1);
  return row ?? null;
}
