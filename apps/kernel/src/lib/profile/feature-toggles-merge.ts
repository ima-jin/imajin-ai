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
import { LEGACY_APP_SLUGS, resolveEnabledApps } from './feature-toggles-compat';

export interface FeatureTogglesFormState {
  /** Keyed by registry app slug plus the kernel-owned `inference` toggle. */
  serviceToggles: Readonly<Record<string, boolean>>;
  showMarketItems: boolean;
  showEvents: boolean;
  /** The profile's own handle — the value the legacy per-app fields have always carried when enabled. */
  handle: string | undefined;
}

/**
 * `enabledApps` is preserved verbatim except for the slugs this form
 * controls: one the user switched OFF must also leave `enabledApps`,
 * and one switched ON must enter it, including legacy app slugs.
 */
function mergeEnabledApps(
  existing: FeatureToggles | null | undefined,
  serviceToggles: Readonly<Record<string, boolean>>,
): string[] | undefined {
  const appToggles = Object.entries(serviceToggles).filter(([slug]) => slug !== 'inference');
  const hasGenericApp = appToggles.some(([slug]) => !(LEGACY_APP_SLUGS as readonly string[]).includes(slug));
  if (existing?.enabledApps === undefined && !hasGenericApp) return undefined;
  const enabled = new Set(resolveEnabledApps(existing));
  for (const [slug, on] of appToggles) {
    if (!on) enabled.delete(slug);
    else enabled.add(slug);
  }
  return [...enabled];
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
    if (!(slug in form.serviceToggles)) continue;
    merged[slug] = form.serviceToggles[slug] && form.handle ? form.handle : null;
  }

  const enabledApps = mergeEnabledApps(existing, form.serviceToggles);
  if (enabledApps !== undefined) {
    merged.enabledApps = enabledApps;
  }
  return merged;
}
