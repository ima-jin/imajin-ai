/**
 * App registry lookups (#1990) — "apps are identities the kernel refuses to
 * serve unregistered."
 *
 * `registry.apps` (Issue #244, extended by 0138_registry_apps_registry_fields.sql)
 * is the kernel's one app-identity table. This module is the single place
 * every scoped app-token mint/verify route (#1069) resolves an `aud` or
 * `appDid` against it, so the enforcement rule and its 403 error body stay
 * consistent across all of them rather than being hand-copied per route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { arrayContains, eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { corsHeaders } from '@imajin/config';
import { clampToApprovedCeiling, ownNamespaceScopes, tokenAudiences, type AppDependency } from '@imajin/auth';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface ActiveRegistryApp {
  id: string;
  appDid: string;
  ownerDid: string;
  tier: string;
  status: string;
  /** The app's registered slug, or `null` for a slug-less (e.g. self-service) app. */
  slug: string | null;
  /** `registry.apps.requested_scopes` — the scope assignment; with `providesScopes` / `dependsOn`, the mint ceiling (#2674). */
  requestedScopes: string[];
  /**
   * Scopes the app defines itself (#2663); granted on tokens minted for its audience.
   * Only those in the app's own slug namespace (#2674): a slug-less row has none.
   */
  providesScopes: string[];
  /** Other registered audiences a token for this app must also carry (#2663). */
  dependsOn: AppDependency[];
  /** Operator approved this app's tokens to carry an act-as (group DID) claim (#2639). */
  actAsAllowed: boolean;
}

/**
 * Resolve the active (non-revoked) registry.apps row whose `token_audiences`
 * contains `aud`, or `null` when no such row exists — either because `aud`
 * was never registered, or because the app that registered it has since been
 * revoked (this is what makes revocation take effect within one verify
 * cycle: a revoked app's `aud` stops resolving immediately, independent of
 * the token's own TTL).
 */
export async function resolveActiveAppByAudience(aud: string | null | undefined): Promise<ActiveRegistryApp | null> {
  if (!aud) return null;
  try {
    const [row] = await db
      .select({
        id: registryApps.id,
        appDid: registryApps.appDid,
        ownerDid: registryApps.ownerDid,
        tier: registryApps.tier,
        status: registryApps.status,
        slug: registryApps.slug,
        requestedScopes: registryApps.requestedScopes,
        providesScopes: registryApps.providesScopes,
        dependsOn: registryApps.dependsOn,
        actAsAllowed: registryApps.actAsAllowed,
      })
      .from(registryApps)
      .where(arrayContains(registryApps.tokenAudiences, [aud]))
      .limit(1);
    if (row?.status !== 'active') return null;
    return {
      ...row,
      slug: row.slug ?? null,
      requestedScopes: row.requestedScopes ?? [],
      providesScopes: ownNamespaceScopes(row.providesScopes ?? [], row.slug),
      dependsOn: row.dependsOn ?? [],
      actAsAllowed: row.actAsAllowed === true,
    };
  } catch (err) {
    log.error({ err: String(err), aud }, 'resolveActiveAppByAudience: lookup failed');
    return null;
  }
}

/**
 * What a token minted for `app` carries (#2663): its audiences and its scopes.
 *
 * Audiences: `aud` itself, plus the audience of every `dependsOn` entry that
 *   - the requested scopes actually reach (least privilege: a token asking for
 *     none of a dependency's scopes doesn't get that audience), and
 *   - still resolves to an active registered app (a revoked or deregistered
 *     dependency is dropped rather than failing the mint).
 *
 * Scopes: when the token carries any dependency audience, they are clamped to
 * exactly what the operator approved — the app's own `providesScopes` plus the
 * listed scopes of the dependencies actually added. Anything else the caller
 * asked for (e.g. `media:write` when only `media:read` was declared) is dropped,
 * because every scope on the token is honoured at every audience it carries.
 * A token with no dependency audience is only valid at the app's own host and is
 * left as requested.
 *
 * Before any of that, the requested scopes are clamped to the app's approved
 * ceiling (#2674) — its `requestedScopes`, `providesScopes`, and approved
 * `dependsOn` scopes — so an app is never minted a scope nobody assigned it.
 */
export async function resolveTokenGrant(
  aud: string,
  app: Pick<ActiveRegistryApp, 'dependsOn' | 'providesScopes' | 'requestedScopes' | 'tier'>,
  wantedScopes: readonly string[],
): Promise<{ audiences: string[]; scopes: string[] }> {
  const requestedScopes = clampToApprovedCeiling(wantedScopes, app);
  const requested = new Set(requestedScopes);
  const reached = app.dependsOn.filter((dep) => dep.scopes.some((s) => requested.has(s)));
  const resolved = await Promise.all(
    reached.map(async (dep) => ((await resolveActiveAppByAudience(dep.aud)) ? dep : null)),
  );
  const added = resolved.filter((dep): dep is AppDependency => dep !== null);
  const audiences = tokenAudiences(aud, added.map((dep) => dep.aud));
  if (added.length === 0) return { audiences, scopes: [...requestedScopes] };

  const approved = new Set([...app.providesScopes, ...added.flatMap((dep) => dep.scopes)]);
  return { audiences, scopes: requestedScopes.filter((s) => approved.has(s)) };
}

/**
 * True iff `appDid` names an active (non-revoked) registry.apps row.
 *
 * A point-in-time registry check available to any route that needs one.
 * Deliberately NOT wired into the shared, "no DB hit"
 * `/auth/api/apps/token/verify` fast path that `requireAppAuth()` calls on
 * every scoped request across the codebase — see that route's docblock for
 * why a per-verify DB dependency was reverted there (#1990).
 */
export async function isAppDidActive(appDid: string | null | undefined): Promise<boolean> {
  if (!appDid) return false;
  try {
    const [row] = await db
      .select({ status: registryApps.status })
      .from(registryApps)
      .where(eq(registryApps.appDid, appDid))
      .limit(1);
    return row?.status === 'active';
  } catch (err) {
    log.error({ err: String(err), appDid }, 'isAppDidActive: lookup failed');
    return false;
  }
}

/** Stable, documented error body for every #1990 "unregistered app" rejection. */
export const APP_NOT_REGISTERED_ERROR = {
  error: 'app_not_registered',
  error_description: 'This app is not registered with the kernel, or its registration has been revoked.',
} as const;

/** 403 response carrying the stable app_not_registered body, with CORS headers matching the caller's route. */
export function appNotRegisteredResponse(request: NextRequest): NextResponse {
  return NextResponse.json(APP_NOT_REGISTERED_ERROR, { status: 403, headers: corsHeaders(request) });
}
