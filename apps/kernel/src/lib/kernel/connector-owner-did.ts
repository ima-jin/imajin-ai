/**
 * Resolve which DID owns a connector's sealed credentials for a request (#1756).
 *
 * Connector status/config/seal routes historically resolved `ownerDid` via
 * `requireAuth()` → `resolveActingDid()`, which returns the logged-in user's
 * DID. That is the right answer for a person managing their own connector
 * credentials, but the app-subsidizes-compute model (#1624) intentionally
 * puts API keys and OAuth config on the **app owner's DID**
 * (`registry.apps.owner_did` — the DID of the developer who registered the
 * app), not on each delegated user's DID. A request made through that app
 * (carrying app-auth context — a bearer app token, or the legacy X-App-DID +
 * X-App-Authorization header pair) must resolve to the app owner's DID
 * instead, or it ends up asking "does this logged-in user have keys?" when it
 * should ask "does the app owner have keys?".
 *
 * Mirrors `resolveInferenceAuth` in `app/api/inference/capture/route.ts`: try
 * app-auth first, and fall back to the session's acting DID — today's
 * unchanged per-user behavior — when no app-auth context is present.
 */
import type { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAppAuth, requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { db, registryApps } from '@/src/db';

const log = createLogger('kernel');

export type ConnectorOwnerResult =
  | { ok: true; ownerDid: string }
  | { ok: false; error: string; status: number };

/** The app owner's DID for `appDid` from `registry.apps`, or undefined when unregistered. */
async function lookupAppOwnerDid(appDid: string): Promise<string | undefined> {
  const rows = await db
    .select({ ownerDid: registryApps.ownerDid })
    .from(registryApps)
    .where(eq(registryApps.appDid, appDid))
    .limit(1);
  return rows[0]?.ownerDid;
}

/**
 * Resolve the DID whose vault fields a connector status/config/seal route
 * should act on for this request.
 *
 * Tries `requireAppAuth` first. On success, resolves the calling app's
 * `owner_did` from `registry.apps` — this is what makes a Gemini/QuickBooks
 * connection sealed under an app owner's DID visible and writable from inside
 * that app, instead of silently checking the wrong DID's vault fields.
 *
 * Falls through to `requireAuth` → `resolveActingDid` (unchanged per-user
 * behavior) when no app-auth context is present. When app-auth headers ARE
 * present but verification failed, this fails closed with the app-auth error
 * rather than silently falling back to a session that may not exist — the
 * same fail-closed precedent `resolveInferenceAuth` set.
 */
export async function resolveConnectorOwnerDid(request: NextRequest): Promise<ConnectorOwnerResult> {
  const appResult = await requireAppAuth(request);
  if ('appAuth' in appResult) {
    const ownerDid = await lookupAppOwnerDid(appResult.appAuth.appDid);
    if (!ownerDid) {
      log.warn(
        { appDid: appResult.appAuth.appDid },
        'connector owner DID: app-auth verified but app is not registered in registry.apps',
      );
      return {
        ok: false,
        error: `App ${appResult.appAuth.appDid} is not a registered app`,
        status: 404,
      };
    }
    return { ok: true, ownerDid };
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    const hasAppAuthHint = Boolean(
      request.headers.get('x-app-did') ||
      request.headers.get('x-app-authorization') ||
      request.headers.get('x-acting-for'),
    );
    if (hasAppAuthHint) {
      return { ok: false, error: appResult.error, status: appResult.status };
    }
    return { ok: false, error: authResult.error, status: authResult.status };
  }

  return { ok: true, ownerDid: resolveActingDid(authResult.identity) };
}
