import { and, eq, inArray } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { canManageGroupApps } from '@/src/lib/kernel/app-membership';

const LEGACY_APP_KEYS = ['links', 'coffee', 'dykil', 'learn'] as const;

/** Public profile JSON hides app names; verified group editors retain full configuration. */
export async function projectPublicAppToggles(
  toggles: object | null | undefined,
  viewer?: { ownerDid: string; viewerDid: string | null },
): Promise<object | null | undefined> {
  if (!toggles) return toggles;
  const fields = toggles as Record<string, unknown>;
  const enabledApps = Array.isArray(fields.enabledApps)
    ? fields.enabledApps.filter((slug): slug is string => typeof slug === 'string') : [];
  const legacyApps = LEGACY_APP_KEYS.filter((slug) => !!fields[slug]);
  const slugs = [...new Set([...enabledApps, ...legacyApps])];
  if (slugs.length === 0) return toggles;
  // The route supplies the cookie-authenticated person, never an acting-as
  // header. Active owner/admin membership is the same authority used for
  // group app edits. Ordinary/removed members still receive public projection.
  if (viewer?.viewerDid && await canManageGroupApps(viewer.ownerDid, viewer.viewerDid)) return toggles;

  const rows = await db.select({ slug: registryApps.slug }).from(registryApps).where(and(
    inArray(registryApps.slug, slugs),
    eq(registryApps.status, 'active'),
    eq(registryApps.visibility, 'public'),
  ));
  const publicSlugs = new Set(rows.map((row) => row.slug));
  const result = { ...fields };
  if (Array.isArray(fields.enabledApps)) {
    result.enabledApps = enabledApps.filter((slug) => publicSlugs.has(slug));
  }
  for (const slug of legacyApps) {
    if (!publicSlugs.has(slug)) result[slug] = null;
  }
  return result;
}
