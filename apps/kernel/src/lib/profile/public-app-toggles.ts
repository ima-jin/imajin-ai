import { and, eq, inArray } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';

const LEGACY_APP_KEYS = ['links', 'coffee', 'dykil', 'learn'] as const;

/** Public profile JSON must not reveal private/internal/unlisted app names. */
export async function projectPublicAppToggles(
  toggles: object | null | undefined,
): Promise<object | null | undefined> {
  if (!toggles) return toggles;
  const fields = toggles as Record<string, unknown>;
  const enabledApps = Array.isArray(fields.enabledApps)
    ? fields.enabledApps.filter((slug): slug is string => typeof slug === 'string') : [];
  const legacyApps = LEGACY_APP_KEYS.filter((slug) => !!fields[slug]);
  const slugs = [...new Set([...enabledApps, ...legacyApps])];
  if (slugs.length === 0) return toggles;

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
