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
 * treats an explicit enabledApps array as authoritative. Only legacy-only
 * profiles fall back to per-app fields, so removing an app cannot resurrect it.
 */
import type { FeatureToggles } from '@/src/db/schemas/profile';

/** The 4 legacy per-app fields this mapper reads for back-compat (#2425). */
export const LEGACY_APP_SLUGS = ['links', 'coffee', 'dykil', 'learn'] as const;

/**
 * Resolve the explicit app slugs, falling back to legacy fields only when
 * the modern `enabledApps` array is absent. Deduped;
 * order is not significant.
 */
export function resolveEnabledApps(featureToggles: FeatureToggles | null | undefined): string[] {
  if (!featureToggles) return [];
  if (featureToggles.enabledApps !== undefined) return [...new Set(featureToggles.enabledApps)];

  const enabled = new Set<string>();
  for (const slug of LEGACY_APP_SLUGS) {
    if (featureToggles[slug]) {
      enabled.add(slug);
    }
  }
  return [...enabled];
}

/**
 * Has this profile EVER configured its app toggles (#2434, #2425 ruling b)?
 * True when `enabledApps` exists (even empty — an explicit "none") or any
 * legacy per-app field is present (even `null`, which the profile edit form
 * writes for an app switched off). A profile whose `feature_toggles` has none
 * of those keys has never touched app toggles. No migration: it is derived from the
 * shape already stored.
 */
export function hasConfiguredAppToggles(featureToggles: FeatureToggles | null | undefined): boolean {
  if (!featureToggles) return false;
  if (featureToggles.enabledApps !== undefined) return true;
  return LEGACY_APP_SLUGS.some((slug) => featureToggles[slug] !== undefined);
}

/** Convenience check for a single slug — `resolveEnabledApps(ft).includes(slug)` without building the whole array at call sites that only need one answer. */
export function isAppEnabled(featureToggles: FeatureToggles | null | undefined, slug: string): boolean {
  return resolveEnabledApps(featureToggles).includes(slug);
}
