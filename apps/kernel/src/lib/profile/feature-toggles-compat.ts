/**
 * FeatureToggles compat mapper (#2425).
 *
 * `profile.profiles.feature_toggles` used to carry one boolean-shaped field
 * per app (`links`, `coffee`, `dykil`, `learn` — see
 * `apps/kernel/src/db/schemas/profile.ts`'s `FeatureToggles`). Those fields
 * are deprecated in favor of a generic, slug-keyed `enabledApps: string[]`,
 * but every row written before this change still has them and MUST keep
 * working — no migration, no data loss.
 *
 * `resolveEnabledApps` is the single place that reconciles both shapes: it
 * is a pure union, so a profile that has only ever used the legacy fields,
 * only the new field, or (transiently) both, all resolve to the same
 * correct enabled-app set.
 */
import type { FeatureToggles } from '@/src/db/schemas/profile';

/** The 4 legacy per-app fields this mapper reads for back-compat (#2425). */
export const LEGACY_APP_SLUGS = ['links', 'coffee', 'dykil', 'learn'] as const;

/**
 * Resolve the full set of app slugs enabled on a profile, unioning the
 * modern `enabledApps` array with any truthy legacy per-app field. Deduped;
 * order is not significant.
 */
export function resolveEnabledApps(featureToggles: FeatureToggles | null | undefined): string[] {
  if (!featureToggles) return [];

  const enabled = new Set(featureToggles.enabledApps ?? []);
  for (const slug of LEGACY_APP_SLUGS) {
    if (featureToggles[slug]) {
      enabled.add(slug);
    }
  }
  return [...enabled];
}

/** Convenience check for a single slug — `resolveEnabledApps(ft).includes(slug)` without building the whole array at call sites that only need one answer. */
export function isAppEnabled(featureToggles: FeatureToggles | null | undefined, slug: string): boolean {
  if (!featureToggles) return false;
  if (featureToggles.enabledApps?.includes(slug)) return true;
  if ((LEGACY_APP_SLUGS as readonly string[]).includes(slug)) {
    return Boolean(featureToggles[slug as (typeof LEGACY_APP_SLUGS)[number]]);
  }
  return false;
}
