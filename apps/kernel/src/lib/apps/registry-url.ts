import { and, eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { nodeUrl } from '@/src/lib/http/node-url';
import { registryAppBaseUrl } from './public-url';

/** An active registration, not nav membership or an app-specific env var, owns its API base. */
export async function resolveRegistryAppBaseUrl(slug: string): Promise<string | null> {
  const [app] = await db.select({
    slug: registryApps.slug,
    entryUrl: registryApps.entryUrl,
    status: registryApps.status,
  }).from(registryApps).where(and(
    eq(registryApps.slug, slug),
    eq(registryApps.status, 'active'),
  )).limit(1);
  if (!app?.slug || app.status !== 'active') return null;
  const base = registryAppBaseUrl({ slug: app.slug, entryUrl: app.entryUrl });
  return base ? new URL(base, nodeUrl()).toString().replace(/\/$/, '') : null;
}
