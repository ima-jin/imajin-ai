/**
 * Merge-not-replace helper for the profile edit form's save (#2434).
 *
 * `profile.profiles.feature_toggles` carries more than the keys the edit
 * form knows about — notably the generic `enabledApps` list (#2425) and any
 * key a future app writes. The form used to build the payload from scratch
 * (`inference_enabled` + `show_*` + the 4 legacy app fields), which is a
 * silent data-loss bug the moment anything else lives in that object.
 *
 * `mergeFeatureToggles` starts from the toggles the profile was LOADED with
 * and overlays only what the form actually controls.
 */
import type { FeatureToggles } from '@/src/db/schemas/profile';
import { LEGACY_APP_SLUGS } from './feature-toggles-compat';

export interface FeatureTogglesFormState {
  /** Keyed by service key: the 4 legacy app slugs plus `inference`. */
  serviceToggles: Readonly<Record<string, boolean>>;
  showMarketItems: boolean;
  showEvents: boolean;
  /** The profile's own handle — the value the legacy per-app fields have always carried when enabled. */
  handle: string | undefined;
}

/**
 * `enabledApps` is preserved verbatim except for the slugs this form
 * controls: one the user switched OFF must also leave `enabledApps`,
 * otherwise `resolveEnabledApps` (a union of both shapes) would keep it
 * enabled and the form's toggle would be silently ineffective.
 */
function mergeEnabledApps(
  existing: readonly string[] | undefined,
  serviceToggles: Readonly<Record<string, boolean>>,
): string[] | undefined {
  if (existing === undefined) return undefined;
  const switchedOff = new Set<string>(LEGACY_APP_SLUGS.filter((slug) => !serviceToggles[slug]));
  return existing.filter((slug) => !switchedOff.has(slug));
}

/** Overlay the edit form's state onto the toggles the profile was loaded with. Never drops unrelated keys. */
export function mergeFeatureToggles(
  existing: FeatureToggles | null | undefined,
  form: FeatureTogglesFormState,
): FeatureToggles {
  const merged: FeatureToggles = {
    ...existing,
    inference_enabled: Boolean(form.serviceToggles['inference']),
    show_market_items: form.showMarketItems,
    show_events: form.showEvents,
  };

  for (const slug of LEGACY_APP_SLUGS) {
    merged[slug] = form.serviceToggles[slug] && form.handle ? form.handle : null;
  }

  const enabledApps = mergeEnabledApps(existing?.enabledApps, form.serviceToggles);
  if (enabledApps !== undefined) {
    merged.enabledApps = enabledApps;
  }
  return merged;
}
