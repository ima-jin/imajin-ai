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
 * Enabled-for-identity resolution mirrors the EXACT pre-existing logic in
 * `apps/kernel/app/auth/layout.tsx` (actor scope sees everything; every
 * other scope is gated by `profile.forest_config.enabled_services` for
 * that identity's own DID) — this module does not change that semantic,
 * it only stops each call site from hand-rolling it against a literal
 * array of app names.
 */
import { and, eq } from 'drizzle-orm';
import { db, identities, forestConfig, registryApps } from '@/src/db';

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

/** `null` return means "actor scope — every nav-capable app is enabled", matching `layout.tsx`'s existing fallback. */
async function resolveEnabledSlugsForIdentity(did: string, scope: string | undefined): Promise<Set<string> | null> {
  if (!scope || scope === 'actor') return null;

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
