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
 *
 * #1773: the app-auth branch used to resolve straight to the app owner's DID,
 * full stop — even when the app-auth context named a delegating human
 * (`appAuth.userDid`, or the legacy `X-Acting-For` header). That is backwards
 * from `resolveInferenceAuth` / `resolveBrain`'s "owner-first" precedence (a
 * human's own card outranks the app's), and it is exactly what made the
 * Gemini model picker 404 with `gemini_no_key` (#1773): the owner sealed their
 * key under their own DID while acting through an app, but this resolver kept
 * looking it up under the app owner's DID instead — a different row that had
 * nothing sealed. A delegating user's DID now wins when one is present; only a
 * pure service token (no delegating user at all) falls through to the app
 * owner's DID, which is the correct home for org-level config like the
 * QuickBooks OAuth App client id/secret.
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
 * Tries `requireAppAuth` first. On success, prefers the app-auth context's
 * delegating user DID (`appAuth.userDid` / `X-Acting-For`) when one is named,
 * and otherwise resolves the calling app's `owner_did` from `registry.apps`
 * — this is what makes a Gemini/QuickBooks connection sealed under either DID
 * visible and writable from inside that app, instead of silently checking the
 * wrong DID's vault fields.
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
    // Owner-first (#1773): a delegating human's own DID outranks the app's,
    // mirroring `resolveInferenceAuth`'s precedence — an app can subsidize
    // compute, but it must never quietly displace whose sealed card a
    // connector route reads or writes. The legacy X-Acting-For header is the
    // same delegating-user signal `resolveInferenceAuth` falls back to.
    const delegatingUserDid =
      appResult.appAuth.userDid || request.headers.get('x-acting-for') || '';
    if (delegatingUserDid) {
      return { ok: true, ownerDid: delegatingUserDid };
    }

    // No delegating user — a service token acting purely on the app's own
    // behalf. Org-level config (e.g. the QuickBooks OAuth App client id/secret)
    // legitimately lives on the app owner's DID, so that is the fallback here.
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
