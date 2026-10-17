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
 * `pay`/`media` are kernel navigation, not registry apps, and stay outside
 * this resolver. The shared launcher gates group Wallet/Media links on
 * forest_config; their standalone pages validate the acting-as session.
 *
 * Enabled-for-identity resolution: every non-actor scope is gated by
 * `profile.forest_config.enabled_services` for that identity's own DID
 * (unchanged from `apps/kernel/app/auth/layout.tsx`'s pre-#2425 logic).
 * Actor scope follows explicit membership (legacy-only fallback) union live
 * person-issued app.authorized grants. No identity gets default apps.
 */
import { and, eq } from 'drizzle-orm';
import { db, identities, forestConfig, registryApps, profiles, attestations } from '@/src/db';
import { resolveEnabledApps } from '@/src/lib/profile/feature-toggles-compat';
import { isLiveAppAuthorization } from '@/src/lib/auth/live-app-authorization';

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
  description?: string | null;
  featured?: boolean;
  appDid?: string;
}
export interface AppDirectoryApp extends NavApp {
  description: string | null;
  featured: boolean;
  added: boolean;
  authorized: boolean;
  available: boolean;
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
      description: registryApps.description,
      featured: registryApps.featured,
      appDid: registryApps.appDid,
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
      description: row.description ?? null,
      featured: row.featured ?? false,
      appDid: row.appDid,
    });
  }
  return apps;
}

/**
 * Explicit actor membership, with fallback for profiles that only have legacy
 * fields. Unconfigured profiles start empty.
 */
async function resolveActorEnabledSlugs(did: string): Promise<Set<string>> {
  const [profileRow] = await db
    .select({ featureToggles: profiles.featureToggles })
    .from(profiles)
    .where(eq(profiles.did, did))
    .limit(1);

  const featureToggles = profileRow?.featureToggles;
  return new Set(resolveEnabledApps(featureToggles));
}

/**
 * Actors use profile membership. Every other scope is gated by
 * `profile.forest_config.enabled_services` for that identity's own DID.
 */
async function resolveEnabledSlugsForIdentity(did: string, scope: string | undefined): Promise<Set<string>> {
  if (!scope) return new Set();
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
  const directory = await resolveAppDirectoryForIdentity(did);
  return directory.filter((app) => app.available && (app.added || app.authorized));
}

/** All active nav-capable apps, including those not yet added or scope-available. */
export async function resolveAppDirectoryForIdentity(did: string): Promise<AppDirectoryApp[]> {
  const [identity] = await db
    .select({ scope: identities.scope })
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);
  const scope = identity?.scope;

  const [navCapable, enabledSlugs, grants] = await Promise.all([
    listNavCapableApps(),
    resolveEnabledSlugsForIdentity(did, scope),
    scope === 'actor'
      ? db.select({
        subjectDid: attestations.subjectDid,
        revokedAt: attestations.revokedAt,
        expiresAt: attestations.expiresAt,
      }).from(attestations).where(and(
        eq(attestations.issuerDid, did),
        eq(attestations.type, 'app.authorized'),
      ))
      : Promise.resolve([]),
  ]);
  const authorizedDids = new Set(grants.filter((grant) => isLiveAppAuthorization(grant)).map((grant) => grant.subjectDid));
  return navCapable.map((app) => ({
    ...app,
    description: app.description ?? null,
    featured: app.featured ?? false,
    added: enabledSlugs.has(app.slug),
    authorized: !!app.appDid && authorizedDids.has(app.appDid),
    available: !!scope && passesScopeGate(app, scope),
  })).sort((a, b) => Number(b.featured) - Number(a.featured)
    || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
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
