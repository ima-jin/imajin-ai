/**
 * Registry-driven kernel navigation (#2425) — the single place every
 * authenticated nav surface (the `/auth` hub's tab bar, its dynamic
 * `/auth/[app]` route, and `GET /auth/api/apps`) resolves "which apps
 * should this identity see" from `registry.apps` (#1990) instead of a
 * hard-coded literal list.
 *
 * Deliberately scoped to the apps #1981 will eventually extract out of the
 * monorepo (coffee, dykil, links, learn, events, market — the rows
 * `0167_registry_apps_nav_metadata.sql` backfills `placements` for).
 * `pay`/`media` are kernel-native services that are never pruned (see
 * `apps/kernel/app/auth/lib/service-registry.ts`'s `isKernelNativeService`)
 * and stay outside this resolver — they are gated by scope/enabledServices
 * directly at each call site, exactly as before this issue.
 *
 * Enabled-for-identity resolution: every non-actor scope is gated by
 * `profile.forest_config.enabled_services` for that identity's own DID
 * (unchanged from `apps/kernel/app/auth/layout.tsx`'s pre-#2425 logic).
 * Actor scope follows the actor's own `feature_toggles` (#2434 — #2425
 * DECISION ruled b); an actor that never configured toggles still sees every
 * app. See `resolveActorEnabledSlugs`.
 */
import { and, eq } from 'drizzle-orm';
import { db, identities, forestConfig, registryApps, profiles } from '@/src/db';
import { hasConfiguredAppToggles, resolveEnabledApps } from '@/src/lib/profile/feature-toggles-compat';

/** The 3 nav surfaces an app registry row can declare itself visible on. */
export type AppPlacement = 'launcher' | 'home' | 'auth-submenu';

export const APP_PLACEMENTS: readonly AppPlacement[] = ['launcher', 'home', 'auth-submenu'];

export interface NavApp {
  slug: string;
  name: string;
  icon: string | null;
  entryUrl: string | null;
  placements: AppPlacement[];
  requiredScope: string | null;
  tier: string;
}

function isAppPlacement(value: string): value is AppPlacement {
  return (APP_PLACEMENTS as readonly string[]).includes(value);
}

/** Every active, slug-having registry row that declares at least one nav placement. */
async function listNavCapableApps(): Promise<NavApp[]> {
  const rows = await db
    .select({
      slug: registryApps.slug,
      name: registryApps.name,
      icon: registryApps.icon,
      entryUrl: registryApps.entryUrl,
      placements: registryApps.placements,
      requiredScope: registryApps.requiredScope,
      tier: registryApps.tier,
      status: registryApps.status,
    })
    .from(registryApps);

  const apps: NavApp[] = [];
  for (const row of rows) {
    if (row.status !== 'active' || !row.slug) continue;
    const placements = (row.placements ?? []).filter(isAppPlacement);
    if (placements.length === 0) continue;
    apps.push({
      slug: row.slug,
      name: row.name,
      icon: row.icon,
      entryUrl: row.entryUrl,
      placements,
      requiredScope: row.requiredScope,
      tier: row.tier,
    });
  }
  return apps;
}

/**
 * Actor scope (#2434, #2425 DECISION ruled b): an actor follows its own
 * `profile.profiles.feature_toggles` (via `resolveEnabledApps`, which unions
 * the legacy per-app fields with `enabledApps`). An actor that has NEVER
 * configured app toggles — see `hasConfiguredAppToggles` — sees every
 * nav-capable app, so existing actors keep today's nav with no migration.
 * `null` means "every nav-capable app is enabled".
 */
async function resolveActorEnabledSlugs(did: string): Promise<Set<string> | null> {
  const [profileRow] = await db
    .select({ featureToggles: profiles.featureToggles })
    .from(profiles)
    .where(eq(profiles.did, did))
    .limit(1);

  const featureToggles = profileRow?.featureToggles;
  if (!hasConfiguredAppToggles(featureToggles)) return null;
  return new Set(resolveEnabledApps(featureToggles));
}

/**
 * `null` return means "every nav-capable app is enabled": an identity with no
 * resolvable scope (matching `layout.tsx`'s existing fallback) or an actor
 * that never configured its toggles. Every other scope is gated by
 * `profile.forest_config.enabled_services` for that identity's own DID.
 */
async function resolveEnabledSlugsForIdentity(did: string, scope: string | undefined): Promise<Set<string> | null> {
  if (!scope) return null;
  if (scope === 'actor') return resolveActorEnabledSlugs(did);

  const [forestRow] = await db
    .select({ enabledServices: forestConfig.enabledServices })
    .from(forestConfig)
    .where(eq(forestConfig.groupDid, did))
    .limit(1);
  return new Set(forestRow?.enabledServices ?? []);
}

/**
 * `requiredScope` gates visibility to a matching IDENTITY scope
 * (`'actor' | 'business' | 'community' | 'family'` — `identities.scope`'s own
 * literal union), never to an app's display/visibility tier (e.g.
 * `packages/config/src/services.ts`'s per-app `visibility: 'creator'`,
 * which is an unrelated concept — see `0167_registry_apps_nav_metadata.sql`'s
 * header for why the first-party backfill leaves this column NULL for all
 * six apps). `NULL` (or actor scope) always passes.
 */
function passesScopeGate(app: NavApp, scope: string | undefined): boolean {
  if (!app.requiredScope) return true;
  if (scope === 'actor') return true;
  return app.requiredScope === scope;
}

/**
 * Resolve the registry apps `did` may see in nav — registry ∩
 * enabled-for-this-identity ∩ scope (#2425's `GET /auth/api/apps` shape).
 * Unfiltered by placement; call {@link filterByPlacement} for a specific
 * surface.
 */
export async function resolveNavAppsForIdentity(did: string): Promise<NavApp[]> {
  const [identity] = await db
    .select({ scope: identities.scope })
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);
  const scope = identity?.scope;

  const [navCapable, enabledSlugs] = await Promise.all([
    listNavCapableApps(),
    resolveEnabledSlugsForIdentity(did, scope),
  ]);

  return navCapable.filter((app) => {
    const enabled = enabledSlugs === null || enabledSlugs.has(app.slug);
    return enabled && passesScopeGate(app, scope);
  });
}

/** Narrow a resolved nav-app list down to the ones visible on a given placement. */
export function filterByPlacement(apps: readonly NavApp[], placement: AppPlacement): NavApp[] {
  return apps.filter((app) => app.placements.includes(placement));
}

/**
 * Registry apps for the PUBLIC launcher / landing grid (#2434): every active
 * registry row declaring the `launcher` placement — the same
 * `listNavCapableApps` source and `filterByPlacement` narrowing every
 * identity-scoped nav surface uses, so a registry-only app (no `services.ts`
 * entry) appears. There is no viewer identity to gate against on the
 * anonymous landing page, so rows with a `requiredScope` are left out (they
 * only surface through {@link resolveNavAppsForIdentity}, which knows the
 * caller's scope); the grid narrows this list further per identity client-side
 * via `GET /auth/api/apps?placement=launcher`.
 */
export async function resolveLauncherApps(): Promise<NavApp[]> {
  const navCapable = await listNavCapableApps();
  return filterByPlacement(
    navCapable.filter((app) => !app.requiredScope),
    'launcher',
  );
}

/**
 * Registry apps matching the given slugs — no identity/scope gating at all
 * (#2425 send-back). For PUBLIC, unauthenticated reads like the profile
 * page's `ServiceLinks`: the PROFILE OWNER (not the viewer) already decided
 * which apps to enable via `feature_toggles`/`resolveEnabledApps`, so there
 * is no viewer identity to gate against here — `resolveNavAppsForIdentity`
 * would be the wrong tool (it answers "what can THIS identity see in its
 * own hub", not "what has THAT profile opted into showing everyone").
 */
export async function resolveRegistryAppsBySlug(slugs: readonly string[]): Promise<NavApp[]> {
  if (slugs.length === 0) return [];
  const navCapable = await listNavCapableApps();
  const slugSet = new Set(slugs);
  return navCapable.filter((app) => slugSet.has(app.slug));
}

/**
 * True when `slug` matches an ACTIVE `registry.apps` row (#2425 send-back
 * item 2b) — used by the health route to accept any registered app rather
 * than the historical 6-app hard-coded list `service-registry.ts` used to
 * carry. Deliberately not placement/scope-gated (unlike
 * {@link resolveNavAppsForIdentity}): a health probe is about reachability
 * of a slug, not about whether the caller's identity can currently see it
 * in nav.
 */
export async function isActiveRegistryAppSlug(slug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: registryApps.id })
    .from(registryApps)
    .where(and(eq(registryApps.slug, slug), eq(registryApps.status, 'active')))
    .limit(1);
  return row !== undefined;
}
