/**
 * App registry lookups (#1990) — "apps are identities the kernel refuses to
 * serve unregistered."
 *
 * `registry.apps` (Issue #244, extended by 0133_registry_apps_registry_fields.sql)
 * is the kernel's one app-identity table. This module is the single place
 * every scoped app-token mint/verify route (#1069) resolves an `aud` or
 * `appDid` against it, so the enforcement rule and its 403 error body stay
 * consistent across all of them rather than being hand-copied per route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { arrayContains, eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { corsHeaders } from '@imajin/config';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface ActiveRegistryApp {
  id: string;
  appDid: string;
  ownerDid: string;
  tier: string;
  status: string;
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
      })
      .from(registryApps)
      .where(arrayContains(registryApps.tokenAudiences, [aud]))
      .limit(1);
    if (!row || row.status !== 'active') return null;
    return row;
  } catch (err) {
    log.error({ err: String(err), aud }, 'resolveActiveAppByAudience: lookup failed');
    return null;
  }
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
