/**
 * Expected token audience for a scoped app token (#2706).
 *
 * The kernel mints a user→app token only for an `aud` listed in
 * `registry.apps.token_audiences`, and `apps.provision` (and the first-party
 * seed) register the app's **slug** there — never a host. Every path-routed
 * app on a node shares one host (`jin.imajin.ai`, `dev-jin.imajin.ai`), so a
 * host-shaped audience would be identical for all of them and a token minted
 * for one app would verify at every other. The audience an app verifies
 * against is therefore always its registry slug:
 *
 *   `IMAJIN_APP_AUD`  (operator override) → otherwise the app's registry slug.
 *
 * Nothing here derives an audience from a URL or host. A value that looks like
 * a host is rejected loudly instead of being passed to the kernel, where it
 * could never match and would silently demote every Bearer client to a 401.
 */

/** Env var an operator may set to override the audience (default: the app's slug). */
export const APP_AUD_ENV = 'IMAJIN_APP_AUD';

/**
 * A registry slug — exactly the pattern `POST /api/apps/provision` accepts
 * (apps/kernel/app/api/apps/provision/route.ts), so every provisionable slug
 * (e.g. `app-`, `a--b`) is a valid audience. No dots, colons or slashes, so a
 * host or URL can never match. A kernel test pins the two patterns together.
 */
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,38}$/;

/** True when `value` is shaped like a registry slug (and therefore not a host or URL). */
export function isAppAudienceSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/**
 * Resolve the audience this app verifies tokens against: `IMAJIN_APP_AUD`
 * when set, else `slug` (the app's registry slug). Throws when neither is
 * available or the result is not slug-shaped.
 */
export function resolveAppAudience(slug?: string): string {
  const fromEnv = process.env[APP_AUD_ENV]?.trim();
  const aud = fromEnv || slug?.trim();
  if (!aud) {
    throw new Error(
      `No app audience configured: pass the app's registry slug (e.g. { slug: 'dykil' }) or set ${APP_AUD_ENV}.`
    );
  }
  if (!isAppAudienceSlug(aud)) {
    const source = fromEnv ? APP_AUD_ENV : 'slug';
    throw new Error(
      `Invalid app audience '${aud}' (from ${source}): audiences are registry slugs, never hosts or URLs.`
    );
  }
  return aud;
}
