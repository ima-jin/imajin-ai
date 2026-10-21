import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { registryAppBaseUrl } from '../apps/public-url';

export interface RegisteredEdgeApp { slug: string; baseUrl: string | null }

/** Same active registry that owns standalone API destinations; no credentials. */
export async function listRegisteredEdgeApps(): Promise<RegisteredEdgeApp[]> {
  const rows = await db.select({ slug: registryApps.slug, entryUrl: registryApps.entryUrl })
    .from(registryApps).where(eq(registryApps.status, 'active')).limit(501);
  if (rows.length > 500) throw new Error('Registered edge inventory exceeds inspection bound');
  return rows.filter((row): row is typeof row & { slug: string } => !!row.slug)
    .map(row => ({ slug: row.slug, baseUrl: registryAppBaseUrl({ slug: row.slug, entryUrl: row.entryUrl }) }));
}
