/**
 * Single resolver for the registry service's base URL (#2061 — kernel was
 * the last `REGISTRY_URL` holdout after #2048 established the
 * `*_SERVICE_URL` convention).
 *
 * The returned value always includes the `/registry` path prefix, like
 * every other `*_SERVICE_URL` (#2046) — callers append only the endpoint
 * path (e.g. `/api/node/self`, `/relay/operations`).
 *
 * Precedence:
 *   1. `REGISTRY_SERVICE_URL` — the current convention.
 *   2. `REGISTRY_URL` — deprecated kernel-only legacy name. Used if set,
 *      but logs a one-time deprecation warning per process.
 *   3. `http://localhost:${PORT || 3000}/registry` — the mode-aware
 *      fallback (PORT is 3000 in dev, 7000 in prod) that
 *      `relay-well-known.ts` already used before this consolidation.
 */

let warnedAboutLegacyRegistryUrl = false;

export function registryServiceUrl(): string {
  if (process.env.REGISTRY_SERVICE_URL) return process.env.REGISTRY_SERVICE_URL;

  if (process.env.REGISTRY_URL) {
    if (!warnedAboutLegacyRegistryUrl) {
      console.warn('REGISTRY_URL is deprecated — set REGISTRY_SERVICE_URL');
      warnedAboutLegacyRegistryUrl = true;
    }
    return process.env.REGISTRY_URL;
  }

  return `http://localhost:${process.env.PORT || 3000}/registry`;
}

/**
 * True when the registry URL is explicitly configured via either the
 * current (`REGISTRY_SERVICE_URL`) or deprecated (`REGISTRY_URL`) env var.
 *
 * `registryServiceUrl()` always returns a value (it falls back to a
 * localhost guess), so callers that previously guarded on
 * `!process.env.REGISTRY_URL` to skip/no-op when the registry isn't
 * configured should check this instead.
 */
export function hasRegistryServiceUrl(): boolean {
  return Boolean(process.env.REGISTRY_SERVICE_URL || process.env.REGISTRY_URL);
}

/**
 * Test-only: resets the one-time deprecation warning latch so each test
 * can assert the warning fires exactly once for its own scenario.
 */
export function __resetRegistryServiceUrlWarningForTests(): void {
  warnedAboutLegacyRegistryUrl = false;
}
